import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool, nestHouseholds, nestMembers, nestInvitations, nestPasteDrafts, nestRecords, nestNotifications } from "@workspace/db";
import { createNestRouter } from "./nest";

test("private paste drafts isolate accounts/households and atomically reject stale edits, discard and saves", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createNestRouter((req) => req.get("x-test-user") ?? null));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const parent = `paste-${randomUUID()}`, child = `paste-${randomUUID()}`, householdMemberUser = `paste-${randomUUID()}`, other = `paste-${randomUUID()}`;
  const houses: string[] = [];
  const call = async (user: string | null, method: string, path: string, data?: unknown) => {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { ...(user ? { "x-test-user": user } : {}), "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  };
  try {
    for (const user of [parent, other]) {
      const result = await call(user, "POST", "/nest/households", { name: "Draft tests", parentName: "Parent", childName: "Child" });
      assert.equal(result.status, 201); houses.push(result.body.id);
    }
    const memberProfile = await call(parent, "POST", "/nest/members", { name: "Household member", role: "householdMember" });
    assert.equal(memberProfile.status, 201);
    const memberInvitation = await call(parent, "POST", "/nest/invitations", { memberId: memberProfile.body.id });
    assert.equal(memberInvitation.status, 201);
    assert.equal((await call(householdMemberUser, "POST", "/nest/join", { code: memberInvitation.body.code })).status, 200);
    const [owner] = await db.select().from(nestMembers).where(eq(nestMembers.authUserId, parent));
    const [kid] = await db.update(nestMembers).set({ authUserId: child }).where(and(eq(nestMembers.householdId, owner.householdId), eq(nestMembers.role, "child"))).returning();
    const path = `/nest/paste-drafts/${owner.id}/groceries`;
    const empty = { text: "Milk\nMilk\nRemoved", drafts: [], reviewing: false, savedCount: 0, showErrors: false, error: "", uncertainId: null, finished: false };
    assert.equal((await call(null, "GET", path)).status, 401);
    assert.deepEqual((await call(parent, "GET", path)).body, { revision: null, session: null });
    for (const user of [child, householdMemberUser, other]) {
      assert.equal((await call(user, "GET", path)).status, 403);
      assert.equal((await call(user, "PUT", path, { revision: null, session: empty })).status, 403);
      assert.equal((await call(user, "POST", `${path}/save`, { revision: randomUUID(), rowId: "a" })).status, 403);
    }
    const first = await call(parent, "PUT", path, { revision: null, session: empty });
    assert.equal(first.status, 200);
    assert.equal((await call(parent, "PUT", path, { revision: null, session: empty })).status, 409);
    assert.equal((await call(parent, "PUT", path, { revision: first.body.revision, session: empty, accountId: child })).status, 400);
    const makeRow = (id: string) => ({ id, title: "Milk", quantity: "2 cartons", assignedTo: "", cadence: "Once", dueDate: "" });
    const session = { ...empty, reviewing: true, drafts: [makeRow("a"), makeRow("b")] };
    let draft = (await call(parent, "PUT", path, { revision: first.body.revision, session })).body;
    assert.equal(draft.session.drafts.length, 2);
    assert.deepEqual((await call(child, "GET", `/nest/paste-drafts/${kid.id}/groceries`)).body, { revision: null, session: null });
    assert.equal((await call(parent, "POST", `${path}/save`, { revision: draft.revision, rowId: "a" })).status, 409);
    assert.equal((await call(parent, "PUT", path, { revision: draft.revision, session: { ...session, drafts: [makeRow("a"), makeRow("a")] } })).status, 400);
    assert.equal((await call(parent, "PUT", path, { revision: draft.revision, session: { ...session, uncertainId: "missing" } })).status, 400);
    assert.equal((await call(parent, "PUT", path, { revision: draft.revision, session: { ...session, text: "x".repeat(20001) } })).status, 400);
    draft = (await call(parent, "PUT", path, { revision: draft.revision, session: { ...session, uncertainId: "a" } })).body;
    const beforeSave = draft.revision;
    const results = await Promise.all([1, 2].map(() => call(parent, "POST", `${path}/save`, { revision: beforeSave, rowId: "a" })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    // Simulate a lost save response: the next GET still knows the confirmed
    // row was removed and the repeated title is a separate remaining item.
    draft = (await call(parent, "GET", path)).body;
    assert.deepEqual(draft.session.drafts.map((r: { id: string }) => r.id), ["b"]);
    assert.equal(draft.session.savedCount, 1);
    assert.equal(draft.session.uncertainId, null);
    let records = await db.select().from(nestRecords).where(eq(nestRecords.householdId, owner.householdId));
    assert.equal(records.length, 1); assert.equal(records[0].data.quantity, "2 cartons");
    assert.equal((await call(parent, "PUT", path, { revision: beforeSave, session: null })).status, 409);
    draft = (await call(parent, "PUT", path, { revision: draft.revision, session: { ...draft.session, uncertainId: "b" } })).body;
    draft = (await call(parent, "POST", `${path}/save`, { revision: draft.revision, rowId: "b" })).body;
    assert.equal(draft.session.finished, true); assert.equal(draft.session.savedCount, 2);
    records = await db.select().from(nestRecords).where(eq(nestRecords.householdId, owner.householdId));
    assert.equal(records.length, 2); assert.deepEqual(records.map((r) => r.data.title), ["Milk", "Milk"]);
    const stale = draft.revision;
    draft = (await call(parent, "PUT", path, { revision: stale, session: null })).body;
    assert.equal(draft.session, null); assert.notEqual(draft.revision, stale);
    assert.equal((await call(parent, "PUT", path, { revision: stale, session })).status, 409);
    const chorePath = `/nest/paste-drafts/${owner.id}/chores`;
    const choreSession = { ...empty, reviewing: true, drafts: [{ ...makeRow("c"), title: "Sweep", assignedTo: kid.id, cadence: "Weekly", dueDate: "2026-10-10" }], uncertainId: "c" };
    const [outsider] = await db.select().from(nestMembers).where(eq(nestMembers.authUserId, other));
    draft = (await call(parent, "PUT", chorePath, { revision: null, session: { ...choreSession, drafts: [{ ...choreSession.drafts[0], assignedTo: outsider.id }] } })).body;
    assert.equal((await call(parent, "POST", `${chorePath}/save`, { revision: draft.revision, rowId: "c" })).status, 400);
    assert.equal((await db.select().from(nestRecords).where(and(eq(nestRecords.householdId, owner.householdId), eq(nestRecords.kind, "chores")))).length, 0);
    draft = (await call(parent, "PUT", chorePath, { revision: draft.revision, session: choreSession })).body;
    draft = (await call(parent, "POST", `${chorePath}/save`, { revision: draft.revision, rowId: "c" })).body;
    assert.equal(draft.session.finished, true);
    const [chore] = await db.select().from(nestRecords).where(and(eq(nestRecords.householdId, owner.householdId), eq(nestRecords.kind, "chores")));
    assert.equal(chore.data.assignedTo, kid.id); assert.equal(chore.data.cadence, "Weekly");
    const paidSession = { ...choreSession, drafts: [{ ...choreSession.drafts[0], id: "paid", title: "Paid imported", assignedTo: "household", isPaid: true, payAmount: "3.29" }], uncertainId: "paid" };
    draft = (await call(parent, "PUT", chorePath, { revision: draft.revision, session: paidSession })).body;
    const resumed = (await call(parent, "GET", chorePath)).body;
    assert.equal(resumed.session.drafts[0].isPaid, true); assert.equal(resumed.session.drafts[0].payAmount, "3.29");
    const saveResponse = await call(parent, "POST", `${chorePath}/save`, { revision: resumed.revision, rowId: "paid" });
    assert.equal(saveResponse.status, 200);
    assert.equal((await call(parent, "POST", `${chorePath}/save`, { revision: resumed.revision, rowId: "paid" })).status, 409);
    const paidChores = await db.select().from(nestRecords).where(and(eq(nestRecords.householdId, owner.householdId), eq(nestRecords.kind, "chores")));
    const paidChore = paidChores.find((record) => record.data.title === "Paid imported")!;
    assert.equal(paidChore.data.assignedTo, "household"); assert.equal(paidChore.data.payAmount, 3.29); assert.equal(paidChore.data.done, false);
    const completed = await call(child, "PATCH", `/nest/records/${paidChore.id}`, { data: { ...paidChore.data, done: true, completedOn: "2026-10-10" } });
    assert.equal(completed.status, 200); assert.equal(completed.body.allowanceEntry.amount, 3.29);
    assert.equal(completed.body.allowanceEntry.title, "Paid imported · Household");
    const childPath = `/nest/paste-drafts/${kid.id}/groceries`;
    draft = (await call(child, "PUT", childPath, { revision: null, session: { ...session, drafts: [makeRow("kid")], uncertainId: "kid" } })).body;
    assert.equal((await call(parent, "GET", childPath)).status, 403);
    assert.equal((await call(child, "POST", `${childPath}/save`, { revision: draft.revision, rowId: "kid" })).status, 200);

    const memberPath = `/nest/paste-drafts/${memberProfile.body.id}/groceries`;
    const memberDraft = await call(householdMemberUser, "PUT", memberPath, { revision: null, session: { ...session, drafts: [makeRow("member")], uncertainId: "member" } });
    assert.equal(memberDraft.status, 200);
    assert.deepEqual((await call(householdMemberUser, "GET", memberPath)).body.session.drafts.map((row: { id: string }) => row.id), ["member"]);
    assert.equal((await call(parent, "GET", memberPath)).status, 403);
    assert.equal((await call(child, "GET", memberPath)).status, 403);
    assert.equal((await call(other, "GET", memberPath)).status, 403);
    assert.equal((await call(householdMemberUser, "POST", `${memberPath}/save`, { revision: memberDraft.body.revision, rowId: "member" })).status, 200);
  } finally {
    for (const householdId of houses) {
      await db.delete(nestNotifications).where(eq(nestNotifications.householdId, householdId));
      await db.delete(nestPasteDrafts).where(eq(nestPasteDrafts.householdId, householdId));
      await db.delete(nestRecords).where(eq(nestRecords.householdId, householdId));
      await db.delete(nestInvitations).where(eq(nestInvitations.householdId, householdId));
      await db.delete(nestMembers).where(eq(nestMembers.householdId, householdId));
      await db.delete(nestHouseholds).where(eq(nestHouseholds.id, householdId));
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});
