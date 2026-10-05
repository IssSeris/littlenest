import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, or, sql } from "drizzle-orm";
import { db, pool, nestHouseholds, nestMembers, nestRecords, nestInvitations, nestNotifications, nestAttachments, nestPasteDrafts } from "@workspace/db";
import { createNestRouter } from "./nest";

test("household API enforces roles, private journals, invitations and isolation", async (t) => {
  const app = express();
  app.use(express.json());
  const stored = new Map<string, Buffer>();
  app.use("/api", createNestRouter((req) => req.get("x-test-user") ?? null, {
    async put(id, bytes) { stored.set(id, Buffer.from(bytes)); },
    read(id) { return Readable.from(stored.get(id)!); },
    async remove(id) { stored.delete(id); },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const parent = `test-parent-${randomUUID()}`;
  const child = `test-child-${randomUUID()}`;

  const addedParent = `test-added-parent-${randomUUID()}`;
  const addedChild = `test-added-child-${randomUUID()}`;
  const addedHouseholdMember = `test-added-household-member-${randomUUID()}`;
  const competingJoiner = `test-competing-joiner-${randomUUID()}`;
  const outsider = `test-outsider-${randomUUID()}`;
  const otherParent = `test-parent-${randomUUID()}`;

  const profiles: Record<"parent" | "child" | "householdMember", string[]> = {
    parent: [], child: [], householdMember: [],
  };
  const houses: string[] = [];
  const call = async (user: string | null, method: string, path: string, data?: object, headers?: Record<string, string>) => {
    const response = await fetch(`${origin}/api/nest${path}`, {
      method,
      headers: { ...(user ? { "x-test-user": user } : {}), ...(data ? { "Content-Type": "application/json" } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  };
  const snapshot = async (user: string) => {
    const response = await call(user, "GET", "/snapshot");
    assert.equal(response.status, 200);
    return response.data;
  };
  const create = async (user: string, kind: string, data: object) => {
    const result = await call(user, "POST", "/records", { kind, data });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.id as string;
  };
  try {
    await t.test("anonymous requests and foreign origins are rejected", async () => {
      assert.equal((await call(null, "GET", "/snapshot")).status, 401);
      assert.equal((await call(null, "POST", "/households", { name: "x", parentName: "x", childName: "x" })).status, 401);
      assert.equal((await call(parent, "GET", "/snapshot", undefined, { Origin: "https://foreign.example" })).status, 403);
      assert.equal((await call(parent, "POST", "/households", { name: "x", parentName: "x", childName: "x" }, { Origin: "https://foreign.example" })).status, 403);
      assert.equal((await call(parent, "GET", "/snapshot")).status, 404);
    });
    const created = await call(parent, "POST", "/households", { name: "API Test Household", parentName: "Test Parent", childName: "Test Child" });
    assert.equal(created.status, 201);
    houses.push(created.data.id);
    const other = await call(otherParent, "POST", "/households", { name: "Other Test Household", parentName: "Other Parent", childName: "Other Child" });
    assert.equal(other.status, 201);
    houses.push(other.data.id);
    await t.test("parents can create repeated profiles with every role and safe defaults", async () => {
      assert.equal((await call(outsider, "POST", "/members", { name: "Not a parent", role: "parent" })).status, 403);
      for (const [role, label] of [["parent", "Parent"], ["child", "Child"], ["householdMember", "Household member"]] as const) {
        for (let number = 1; number <= 4; number++) {
          const response = await call(parent, "POST", "/members", { name: `${label} ${number}`, role });
          assert.equal(response.status, 201, JSON.stringify(response.data));
          assert.equal(response.data.role, role);
          assert.equal(response.data.linked, false);
          assert.match(response.data.avatarId, /^(animals|bugs|reptiles)-01-a$/);
          assert.equal(response.data.trackingLabel, "School & work");
          profiles[role].push(response.data.id);
        }
      }
      for (const invalid of [
        { name: "", role: "child" }, { name: "   ", role: "child" },
        { name: "x".repeat(81), role: "parent" }, { name: "Unknown", role: "owner" },
        { name: "Forged fields", role: "child", householdId: "foreign", authUserId: "forged" },
      ]) assert.equal((await call(parent, "POST", "/members", invalid)).status, 400);
      const first = await snapshot(parent);
      const second = await snapshot(parent);
      assert.equal(first.members.filter((member: any) => member.role === "parent").length, 5);
      assert.equal(first.members.filter((member: any) => member.role === "child").length, 5);
      assert.equal(first.members.filter((member: any) => member.role === "householdMember").length, 4);
      assert.deepEqual(second.members.map((member: any) => member.id).sort(), first.members.map((member: any) => member.id).sort());
    });
    await t.test("accounts have fixed roles and single-use, expiring invitations", async () => {
      assert.equal((await call(parent, "POST", "/households", { name: "Duplicate", parentName: "P", childName: "C" })).status, 409);
      const [originalChild] = await db.select().from(nestMembers).where(and(
        eq(nestMembers.householdId, houses[0]!), eq(nestMembers.role, "child"), eq(nestMembers.name, "Test Child"),
      ));
      const [otherChild] = await db.select().from(nestMembers).where(and(
        eq(nestMembers.householdId, houses[1]!), eq(nestMembers.role, "child"),
      ));
      const originalChildId = originalChild.id;
      const otherChildId = otherChild.id;
      let invitation = await call(parent, "POST", "/invitations", { memberId: originalChildId });
      assert.equal(invitation.status, 201);
      assert.equal(invitation.data.memberId, originalChildId);
      await db.update(nestInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(nestInvitations.memberId, originalChildId));
      assert.equal((await call(child, "POST", "/join", { code: invitation.data.code })).status, 400);
      const oldCode = (await call(parent, "POST", "/invitations", { memberId: originalChildId })).data.code;
      invitation = await call(parent, "POST", "/invitations", { memberId: originalChildId });
      assert.equal((await call(child, "POST", "/join", { code: oldCode })).status, 400);
      assert.equal((await call(child, "POST", "/join", { code: invitation.data.code, role: "parent" })).status, 400);
      assert.equal((await call(child, "POST", "/join", { code: invitation.data.code })).status, 200);
      assert.equal((await snapshot(child)).role, "child");
      assert.equal((await call(outsider, "POST", "/join", { code: invitation.data.code })).status, 400);
      assert.equal((await call(parent, "POST", "/join", { code: invitation.data.code })).status, 409);
      assert.equal((await call(child, "POST", "/invitations")).status, 403);
      assert.equal((await call(parent, "POST", "/invitations", { memberId: originalChildId })).status, 409);
      assert.equal((await call(parent, "POST", "/invitations", { memberId: otherChildId })).status, 404);
      const raceCode = (await call(otherParent, "POST", "/invitations", { memberId: otherChildId })).data.code;
      const results = await Promise.all([
        call(`test-race-${randomUUID()}`, "POST", "/join", { code: raceCode }),
        call(`test-race-${randomUUID()}`, "POST", "/join", { code: raceCode }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    });
    await t.test("profile invitations are independent, role-bound, and safe under concurrent account linking", async () => {
      const firstChild = profiles.child[0]!;
      const secondChild = profiles.child[1]!;
      const firstCode = await call(parent, "POST", "/invitations", { memberId: firstChild });
      const secondCode = await call(parent, "POST", "/invitations", { memberId: secondChild });
      const replacement = await call(parent, "POST", "/invitations", { memberId: firstChild });
      assert.equal(firstCode.status, 201);
      assert.equal(secondCode.status, 201);
      assert.equal(replacement.status, 201);
      assert.equal((await call(addedChild, "POST", "/join", { code: firstCode.data.code })).status, 400);
      assert.equal((await call(addedChild, "POST", "/join", { code: replacement.data.code })).status, 200);
      assert.equal((await snapshot(addedChild)).activeId, firstChild);
      assert.equal((await call(`test-profile-child-${randomUUID()}`, "POST", "/join", { code: secondCode.data.code })).status, 200);
      assert.equal((await snapshot(parent)).members.find((member: any) => member.id === firstChild).linked, true);
      assert.equal((await snapshot(parent)).members.find((member: any) => member.id === profiles.child[2]).linked, false);

      const raceTargetA = profiles.child[2]!;
      const raceTargetB = profiles.child[3]!;
      const codeA = await call(parent, "POST", "/invitations", { memberId: raceTargetA });
      const codeB = await call(parent, "POST", "/invitations", { memberId: raceTargetB });
      const joinRace = await Promise.all([
        call(competingJoiner, "POST", "/join", { code: codeA.data.code }),
        call(competingJoiner, "POST", "/join", { code: codeB.data.code }),
      ]);
      assert.deepEqual(joinRace.map((result) => result.status).sort(), [200, 409]);
      const linkedTargets = (await snapshot(parent)).members.filter((member: any) => [raceTargetA, raceTargetB].includes(member.id) && member.linked);
      assert.equal(linkedTargets.length, 1);
      const pendingTarget = (await snapshot(parent)).members.find((member: any) => [raceTargetA, raceTargetB].includes(member.id) && !member.linked);
      assert.ok(pendingTarget);

      const replacementTarget = profiles.parent[1]!;
      const replacementOld = await call(parent, "POST", "/invitations", { memberId: replacementTarget });
      const replacementJoiner = `test-replacement-joiner-${randomUUID()}`;
      const [replacementResult, redemptionResult] = await Promise.all([
        call(parent, "POST", "/invitations", { memberId: replacementTarget }),
        call(replacementJoiner, "POST", "/join", { code: replacementOld.data.code }),
      ]);
      if (redemptionResult.status === 200) {
        assert.equal(replacementResult.status, 409);
        assert.equal((await snapshot(replacementJoiner)).activeId, replacementTarget);
      } else {
        assert.equal(redemptionResult.status, 400);
        assert.equal(replacementResult.status, 201);
        assert.equal((await call(replacementJoiner, "POST", "/join", { code: replacementResult.data.code })).status, 200);
      }

      const parentTarget = profiles.parent[0]!;
      const parentInvite = await call(parent, "POST", "/invitations", { memberId: parentTarget });
      assert.equal(parentInvite.status, 201);
      assert.equal((await call(addedParent, "POST", "/join", { code: parentInvite.data.code })).status, 200);
      assert.equal((await snapshot(addedParent)).role, "parent");
      assert.equal((await snapshot(parent)).members.find((member: any) => member.id === parentTarget).linked, true);
      const createdByAddedParent = await call(addedParent, "POST", "/members", { name: "Created by another parent", role: "householdMember" });
      assert.equal(createdByAddedParent.status, 201);
      assert.equal(createdByAddedParent.data.linked, false);
      const invitationByAddedParent = await call(addedParent, "POST", "/invitations", { memberId: createdByAddedParent.data.id });
      assert.equal(invitationByAddedParent.status, 201);
      assert.equal(invitationByAddedParent.data.memberId, createdByAddedParent.data.id);

      const householdTarget = profiles.householdMember[0]!;
      const householdInvite = await call(parent, "POST", "/invitations", { memberId: householdTarget });
      assert.equal(householdInvite.status, 201);
      assert.equal((await call(addedHouseholdMember, "POST", "/join", { code: householdInvite.data.code })).status, 200);
      assert.equal((await snapshot(addedHouseholdMember)).role, "householdMember");
      assert.equal((await snapshot(parent)).members.find((member: any) => member.id === householdTarget).linked, true);
      assert.equal((await call(addedHouseholdMember, "POST", "/join", { code: householdInvite.data.code })).status, 409);
      assert.equal((await snapshot(addedParent)).members.some((member: any) => member.id === householdTarget), true);
      for (const user of [child, addedChild, addedHouseholdMember]) {
        assert.equal((await call(user, "POST", "/members", { name: "Forbidden", role: "parent" })).status, 403);
        assert.equal((await call(user, "POST", "/invitations", { memberId: profiles.child[0] })).status, 403);
        assert.equal((await call(user, "PATCH", `/members/${parentTarget}`, { name: "Not allowed" })).status, 403);
      }
      assert.equal((await call(parent, "POST", "/invitations", { memberId: (await snapshot(otherParent)).activeId })).status, 404);
    });
    const p = await snapshot(parent);
    const parentId = p.activeId;
    const childId = (await snapshot(child)).activeId;
    const otherId = (await snapshot(otherParent)).activeId;
    const moneyData = { title: "Private finance", amount: 10.25, date: "2026-10-03", category: "Home", kind: "expense" };
    const moneyId = await create(parent, "money", moneyData);
    await t.test("finances and household settings remain parent-only", async () => {
      assert.equal((await snapshot(child)).money, undefined);
      assert.equal((await snapshot(addedHouseholdMember)).money, undefined);
      assert.equal((await call(child, "POST", "/records", { kind: "money", data: moneyData })).status, 403);
      assert.equal((await call(addedHouseholdMember, "POST", "/records", { kind: "money", data: moneyData })).status, 403);
      assert.equal((await call(child, "PATCH", `/records/${moneyId}`, { data: moneyData })).status, 404);
      assert.equal((await call(addedHouseholdMember, "PATCH", `/records/${moneyId}`, { data: moneyData })).status, 404);
      assert.equal((await call(child, "DELETE", `/records/${moneyId}`)).status, 404);
      assert.equal((await call(addedHouseholdMember, "DELETE", `/records/${moneyId}`)).status, 404);
      const secondParentMoney = await call(addedParent, "POST", "/records", { kind: "money", data: { ...moneyData, title: "Other parent entry" } });
      assert.equal(secondParentMoney.status, 201);
      assert.equal((await snapshot(parent)).money.some((entry: any) => entry.id === secondParentMoney.data.id), true);
      assert.equal((await call(child, "PATCH", `/members/${childId}`, { name: "Nope" })).status, 403);
      assert.equal((await call(addedHouseholdMember, "PATCH", `/members/${childId}`, { name: "Nope" })).status, 403);
      assert.equal((await call(parent, "PATCH", `/members/${childId}`, { role: "parent" })).status, 200);
      assert.equal((await snapshot(child)).role, "parent");
      assert.equal((await call(parent, "PATCH", `/members/${childId}`, { role: "owner" })).status, 400);
      assert.equal((await call(parent, "PATCH", `/members/${childId}`, { role: "child" })).status, 200);
      assert.equal((await call(parent, "PATCH", `/members/${childId}`, { name: "Renamed Child", avatarId: "bugs-02-b" })).status, 200);
      assert.equal((await snapshot(child)).members.find((m: any) => m.id === childId).name, "Renamed Child");
    });
    await t.test("monthly budget plans are private, unique, and parent-managed", async () => {
      const budgetPlan = {
        month: "2026-10", incomeTarget: 6000, savingsTarget: 500, note: "Build the rainy-day fund",
        categories: [{ category: "Groceries", amount: 750, note: "Weekly shop" }, { category: "Home", amount: 1700 }],
      };
      assert.equal((await call(child, "POST", "/records", { kind: "budgetPlans", data: budgetPlan })).status, 403);
      const created = await call(parent, "POST", "/records", { kind: "budgetPlans", data: budgetPlan });
      assert.equal(created.status, 201);
      const planId = created.data.id;
      const parentSnapshot = await snapshot(parent);
      assert.equal(parentSnapshot.budgetPlans.length, 1);
      assert.deepEqual(parentSnapshot.budgetPlans[0], { id: planId, ...budgetPlan });
      assert.deepEqual((await snapshot(child)).budgetPlans, []);
      assert.equal((await call(child, "PATCH", `/records/${planId}`, { data: budgetPlan })).status, 404);
      assert.equal((await call(child, "DELETE", `/records/${planId}`)).status, 404);
      assert.equal((await call(otherParent, "PATCH", `/records/${planId}`, { data: budgetPlan })).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${planId}`, { data: { ...budgetPlan, month: "2026-11" } })).status, 400);
      assert.equal((await snapshot(parent)).budgetPlans[0].month, "2026-10");
      for (const invalid of [
        { ...budgetPlan, month: "2026-13" },
        { ...budgetPlan, incomeTarget: -1 },
        { ...budgetPlan, categories: [{ category: "Food", amount: 100 }, { category: " food ", amount: 200 }] },
        { ...budgetPlan, categories: [{ category: "", amount: 0 }] },
      ]) assert.equal((await call(parent, "POST", "/records", { kind: "budgetPlans", data: invalid })).status, 400);
      const concurrentPlans = await Promise.all([
        call(parent, "POST", "/records", { kind: "budgetPlans", data: { ...budgetPlan, month: "2026-11" } }),
        call(parent, "POST", "/records", { kind: "budgetPlans", data: { ...budgetPlan, month: "2026-11" } }),
      ]);
      assert.deepEqual(concurrentPlans.map((response) => response.status).sort(), [201, 409]);
      assert.equal((await snapshot(parent)).budgetPlans.filter((plan: any) => plan.month === "2026-11").length, 1);
      assert.equal((await call(parent, "PATCH", `/records/${planId}`, { data: { ...budgetPlan, savingsTarget: 700 } })).status, 200);
      assert.equal((await snapshot(parent)).budgetPlans.find((plan: any) => plan.id === planId).savingsTarget, 700);
      assert.equal((await call(parent, "DELETE", `/records/${planId}`)).status, 204);
      assert.equal((await snapshot(parent)).budgetPlans.some((plan: any) => plan.id === planId), false);
    });
    await t.test("school and work tracking is customizable without changing profile permissions", async () => {
      assert.equal((await snapshot(parent)).members.find((m: any) => m.id === parentId).trackingLabel, "School & work");
      assert.equal((await call(parent, "PATCH", `/members/${parentId}`, { trackingLabel: "  Work projects  " })).status, 200);
      assert.equal((await call(parent, "PATCH", `/members/${childId}`, { trackingLabel: "College" })).status, 200);
      assert.equal((await snapshot(child)).members.find((m: any) => m.id === parentId).trackingLabel, "Work projects");
      assert.equal((await call(child, "PATCH", `/members/${childId}`, { trackingLabel: "  Career training  " })).status, 200);
      assert.equal((await snapshot(parent)).members.find((m: any) => m.id === childId).trackingLabel, "Career training");
      assert.equal((await call(child, "PATCH", `/members/${parentId}`, { trackingLabel: "Not allowed" })).status, 403);
      assert.equal((await call(child, "PATCH", `/members/${childId}`, { trackingLabel: "Work", name: "Not allowed" })).status, 403);
      assert.equal((await call(child, "PATCH", `/members/${parentId}`, { trackingLabel: "Work", avatarId: "bugs-01-a" })).status, 403);
      for (const trackingLabel of ["", "   ", "x".repeat(81)]) {
        assert.equal((await call(parent, "PATCH", `/members/${parentId}`, { trackingLabel })).status, 400);
      }
      const after = await snapshot(child);
      assert.equal(after.members.find((m: any) => m.id === childId).name, "Renamed Child");
      assert.equal(after.members.find((m: any) => m.id === childId).avatarId, "bugs-02-b");
    });
    await t.test("children can save their own avatar but cannot change other profiles or parent-only settings", async () => {
      const before = await snapshot(child);
      const parentBefore = before.members.find((m: any) => m.id === parentId);
      for (const avatarId of ["animals-12-b", "bugs-04-a", "reptiles-03-b"]) {
        assert.equal((await call(child, "PATCH", `/members/${childId}`, { avatarId })).status, 200);
        assert.equal((await snapshot(child)).members.find((m: any) => m.id === childId).avatarId, avatarId);
        assert.equal((await snapshot(parent)).members.find((m: any) => m.id === childId).avatarId, avatarId);
      }
      assert.equal((await call(child, "PATCH", `/members/${childId}`, { avatarId: "bugs-02-b", trackingLabel: "Career training" })).status, 200);
      for (const avatarId of ["", "animals-13-a", "https://example.com/avatar.webp"]) {
        assert.equal((await call(child, "PATCH", `/members/${childId}`, { avatarId })).status, 400);
      }
      assert.equal((await call(child, "PATCH", `/members/${parentId}`, { avatarId: "bugs-01-a" })).status, 403);
      assert.equal((await call(child, "PATCH", `/members/${otherId}`, { avatarId: "bugs-01-a" })).status, 403);
      assert.equal((await call(child, "PATCH", `/members/${childId}`, { avatarId: "bugs-01-a", name: "Renamed Child" })).status, 403);
      assert.equal((await call(child, "PATCH", `/members/${childId}`, { avatarId: "bugs-01-a", role: "parent" })).status, 403);
      const after = await snapshot(parent);
      assert.deepEqual(after.members.find((m: any) => m.id === parentId), parentBefore);
      assert.equal(after.members.find((m: any) => m.id === childId).name, "Renamed Child");
      assert.equal(after.members.find((m: any) => m.id === childId).avatarId, "bugs-02-b");
      assert.equal(after.members.find((m: any) => m.id === childId).role, "child");
    });
    const parentJournal = await create(parent, "journal", { promptId: "p1", body: "Parent private text", shared: true, mood: "sad" });
    const childJournal = await create(child, "journal", { promptId: "p2", body: "Child private text" });
    await t.test("journals are private by default and only authors control them", async () => {
      assert.equal((await snapshot(parent)).journal.find((r: any) => r.id === parentJournal).shared, false);
      assert.equal((await snapshot(parent)).journal.find((r: any) => r.id === parentJournal).mood, "sad");
      assert.equal((await snapshot(child)).journal.find((r: any) => r.id === childJournal).mood, undefined);
      assert.equal((await snapshot(child)).journal.some((r: any) => r.id === parentJournal), false);
      assert.equal((await snapshot(parent)).journal.some((r: any) => r.id === childJournal), false);
      assert.equal((await call(parent, "PATCH", `/records/${childJournal}`, { data: { promptId: "p2", body: "Stolen", shared: true } })).status, 404);
      assert.equal((await call(parent, "DELETE", `/records/${childJournal}`)).status, 404);
      assert.equal((await call(child, "POST", "/records", { kind: "journal", data: { promptId: "p1", body: "Forged", authorId: parentId } })).status, 400);
      const change = { promptId: "p1", body: "Now shared", shared: true, mood: "hopeful" };
      assert.equal((await call(parent, "PATCH", `/records/${parentJournal}`, { data: change })).status, 200);
      assert.equal((await snapshot(child)).journal.find((r: any) => r.id === parentJournal).body, "Now shared");
      assert.equal((await snapshot(child)).journal.find((r: any) => r.id === parentJournal).mood, "hopeful");
      assert.equal((await call(child, "PATCH", `/records/${parentJournal}`, { data: change })).status, 404);
      assert.equal((await call(child, "DELETE", `/records/${parentJournal}`)).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${parentJournal}`, { data: { ...change, shared: false } })).status, 200);
      assert.equal((await snapshot(child)).journal.some((r: any) => r.id === parentJournal), false);
      assert.equal((await call(parent, "PATCH", `/records/${parentJournal}`, { data: { promptId: "p1", body: "Legacy client edit" } })).status, 200);
      assert.equal((await snapshot(parent)).journal.find((r: any) => r.id === parentJournal).mood, "hopeful");
      assert.equal((await call(parent, "PATCH", `/records/${parentJournal}`, { data: { promptId: "p1", body: "Clear mood", mood: null } })).status, 200);
      assert.equal((await snapshot(parent)).journal.find((r: any) => r.id === parentJournal).mood, null);
      assert.equal((await call(parent, "PATCH", `/records/${parentJournal}`, { data: { promptId: "p1", body: "Bad mood", mood: "unknown" } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "journal", data: { promptId: "p1", body: "Bad mood", mood: 123 } })).status, 400);
      assert.equal((await call(child, "PATCH", `/records/${childJournal}`, { data: { promptId: "p2", body: "Edited private child" } })).status, 200);
      assert.equal((await call(child, "DELETE", `/records/${childJournal}`)).status, 204);
    });
    await t.test("journal replies follow shared-entry access and only their authors can mutate them", async () => {
      const entryData = { promptId: "p1", body: "Concurrent reply thread" };
      const entryId = await create(parent, "journal", entryData);
      const replyData = { entryId, body: " Child reply " };
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: replyData })).status, 404);
      assert.equal((await call(parent, "POST", "/records", { kind: "journalReplies", data: replyData })).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: true } })).status, 200);
      const childReplyId = await create(child, "journalReplies", replyData);
      const parentReplyId = await create(parent, "journalReplies", { entryId, body: "Parent reply" });
      const childReply = (await snapshot(parent)).journalReplies.find((r: any) => r.id === childReplyId);
      assert.equal(childReply.body, "Child reply");
      assert.equal(childReply.authorId, childId);
      assert.ok(childReply.createdAt);
      assert.equal((await snapshot(child)).journalReplies.find((r: any) => r.id === parentReplyId).authorId, parentId);
      assert.equal((await snapshot(otherParent)).journalReplies.some((r: any) => r.entryId === entryId), false);
      for (const [user, replyId] of [[parent, childReplyId], [child, parentReplyId], [otherParent, childReplyId]]) {
        assert.equal((await call(user, "PATCH", `/records/${replyId}`, { data: { entryId, body: "Unauthorized edit" } })).status, 404);
        assert.equal((await call(user, "DELETE", `/records/${replyId}`)).status, 404);
      }
      assert.equal((await call(otherParent, "POST", "/records", { kind: "journalReplies", data: replyData })).status, 404);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: { ...replyData, authorId: parentId } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: { ...replyData, createdAt: "2000-01-01" } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: { entryId, body: " " } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: { entryId, body: "x".repeat(5001) } })).status, 400);
      assert.equal((await call(parent, "POST", "/records", { kind: "journalReplies", data: { entryId: moneyId, body: "Wrong kind" } })).status, 404);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: { entryId: randomUUID(), body: "Missing" } })).status, 404);
      assert.equal((await call(child, "PATCH", `/records/${childReplyId}`, { data: { entryId: parentJournal, body: "Move reply" } })).status, 400);
      assert.equal((await call(child, "PATCH", `/records/${childReplyId}`, { data: { entryId, body: "Edited child reply" } })).status, 200);
      assert.equal((await snapshot(parent)).journalReplies.find((r: any) => r.id === childReplyId).createdAt, childReply.createdAt);
      assert.equal((await snapshot(parent)).journalReplies.find((r: any) => r.id === childReplyId).body, "Edited child reply");
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: false } })).status, 200);
      assert.equal((await snapshot(parent)).journalReplies.some((r: any) => r.entryId === entryId), false);
      assert.equal((await snapshot(child)).journalReplies.some((r: any) => r.entryId === entryId), false);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: replyData })).status, 404);
      assert.equal((await call(child, "PATCH", `/records/${childReplyId}`, { data: { entryId, body: "Hidden edit" } })).status, 404);
      assert.equal((await call(child, "DELETE", `/records/${childReplyId}`)).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: true } })).status, 200);
      assert.equal((await snapshot(child)).journalReplies.filter((r: any) => r.entryId === entryId).length, 2);
      assert.equal((await call(child, "DELETE", `/records/${childReplyId}`)).status, 204);
      assert.equal((await snapshot(parent)).journalReplies.filter((r: any) => r.entryId === entryId).length, 1);
      assert.equal((await call(parent, "DELETE", `/records/${entryId}`)).status, 204);
      assert.equal((await snapshot(child)).journalReplies.some((r: any) => r.entryId === entryId), false);
      assert.equal((await db.select().from(nestRecords).where(eq(nestRecords.id, parentReplyId))).length, 0);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: replyData })).status, 404);
    });
    await t.test("concurrent journal deletion and replying cannot leave an orphan conversation", async () => {
      for (let i = 0; i < 3; i++) {
        const entryData = { promptId: "p1", body: "Concurrent reply thread" };
        const entryId = await create(parent, "journal", entryData);
        assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: true } })).status, 200);
        const [reply, removed] = await Promise.all([
          call(child, "POST", "/records", { kind: "journalReplies", data: { entryId, body: "Concurrent reply" } }),
          call(parent, "DELETE", `/records/${entryId}`),
        ]);
        assert.ok([201, 404].includes(reply.status));
        assert.equal(removed.status, 204);
        assert.equal((await db.select().from(nestRecords).where(sql`${nestRecords.data}->>'entryId' = ${entryId}`)).length, 0);
      }
    });
    await t.test("paid household chores earn allowance once per due date under concurrent completion", async () => {
      const input = { title: "Paid household work", assignedTo: "household", cadence: "Weekly", dueDate: "2026-10-05", done: false, isPaid: true, payAmount: 4.25 };
      const choreId = await create(parent, "chores", input);
      const before = (await snapshot(child)).chores.find((row: any) => row.id === choreId);
      assert.equal(before.assignedTo, "household");
      assert.equal(before.isPaid, true);
      assert.equal(before.payAmount, 4.25);
      const complete = { ...input, done: true, completedOn: "2026-10-05" };
      const responses = await Promise.all([
        call(parent, "PATCH", `/records/${choreId}`, { data: complete }),
        call(child, "PATCH", `/records/${choreId}`, { data: complete }),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      const credits = responses.flatMap((response) => response.data.allowanceEntry ? [response.data.allowanceEntry] : []);
      assert.equal(credits.length, 1);
      assert.equal(credits[0].amount, 4.25);
      assert.equal(credits[0].status, "earned");
      assert.equal(credits[0].date, "2026-10-05");
      assert.equal(credits[0].title, "Paid household work · Household");
      const saved = (await snapshot(parent)).chores.find((row: any) => row.id === choreId);
      assert.equal(saved.allowanceRecorded, true);
      assert.equal(saved._allowanceAwards, undefined);
      assert.equal((await snapshot(otherParent)).allowance.some((row: any) => row.id === credits[0].id), false);
      assert.equal((await call(otherParent, "PATCH", `/records/${choreId}`, { data: complete })).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${choreId}`, { data: { ...input, _allowanceAwards: {} } })).status, 400);
      assert.equal((await call(parent, "PATCH", `/records/${choreId}`, { data: input })).status, 200);
      assert.equal((await call(child, "PATCH", `/records/${choreId}`, { data: complete })).data.allowanceEntry, undefined);
      assert.equal((await snapshot(parent)).allowance.filter((row: any) => row.title === credits[0].title).length, 1);

      // Older clients omit paid fields. Preserve the saved pay configuration.
      const nextOccurrence = { title: input.title, assignedTo: input.assignedTo, cadence: input.cadence, dueDate: "2026-10-12", done: false };
      assert.equal((await call(parent, "PATCH", `/records/${choreId}`, { data: nextOccurrence })).status, 200);
      const next = await call(child, "PATCH", `/records/${choreId}`, { data: { ...nextOccurrence, done: true, completedOn: "2026-10-12" } });
      assert.equal(next.status, 200);
      assert.equal(next.data.allowanceEntry.amount, 4.25);
      assert.notEqual(next.data.allowanceEntry.id, credits[0].id);
      assert.equal((await snapshot(parent)).allowance.filter((row: any) => row.title === credits[0].title).length, 2);
      assert.equal((await call(parent, "PATCH", `/records/${choreId}`, { data: { ...nextOccurrence, payAmount: 0 } })).status, 400);
      assert.equal((await snapshot(parent)).chores.find((row: any) => row.id === choreId).payAmount, 4.25);
    });
    await t.test("individual paid chores and unpaid household chores validate without guessing payments", async () => {
      const input = { title: "Individual paid work", assignedTo: childId, cadence: "Once", dueDate: "2026-10-06", done: false, isPaid: true, payAmount: 2.29 };
      const childName = (await snapshot(parent)).members.find((member: any) => member.id === childId).name;
      for (let index = 0; index < 2; index++) {
        const choreId = await create(parent, "chores", input);
        const response = await call(parent, "PATCH", `/records/${choreId}`, { data: { ...input, done: true } });
        assert.equal(response.status, 200);
        assert.equal(response.data.allowanceEntry.title, `Individual paid work · ${childName}`);
        assert.equal(response.data.allowanceEntry.amount, 2.29);
      }
      assert.equal((await snapshot(parent)).allowance.filter((row: any) => row.title === `Individual paid work · ${childName}`).length, 2);
      const unpaid = { title: "Unpaid household work", assignedTo: "household", cadence: "Once", dueDate: "2026-10-06", done: false };
      const unpaidId = await create(child, "chores", unpaid);
      const result = await call(child, "PATCH", `/records/${unpaidId}`, { data: { ...unpaid, done: true } });
      assert.equal(result.status, 200);
      assert.equal(result.data.allowanceEntry, undefined);
      for (const payAmount of [0, -1, 0.005, 10000001]) {
        assert.equal((await call(parent, "POST", "/records", { kind: "chores", data: { ...input, payAmount } })).status, 400);
      }
      assert.equal((await call(parent, "POST", "/records", { kind: "chores", data: { ...input, assignedTo: otherId } })).status, 400);
    });
    await t.test("shared collections support create, edit, completion, and delete across accounts", async () => {
      const samples: Record<string, Record<string, unknown>> = {
        chores: { title: "Shared chore", assignedTo: childId, cadence: "Weekly", dueDate: "2026-10-03", done: false },
        allowance: { title: "Shared allowance", amount: 2.5, date: "2026-10-03", status: "earned" },
        events: { title: "Shared event", memberId: childId, date: "2026-10-03", time: "All day", category: "Home" },
        schoolTasks: { title: "Shared school task", memberId: parentId, dueDate: "2026-10-03", course: "Math", done: false },
        goals: { title: "Shared goal", memberId: childId, progress: 0, targetDate: "2026-10-03" },
        groceries: { title: "Shared groceries", quantity: "2 cartons", done: false },
        groceryFavorites: { title: "Shared favorite", quantity: "1 bag" },
      };
      for (const [kind, sample] of Object.entries(samples)) {
        const recordId = await create(parent, kind, sample);
        assert.equal((await snapshot(child))[kind].find((r: any) => r.id === recordId).title, sample.title);
        const changed = { ...sample, title: `${sample.title} edited`, ...(kind === "goals" ? { progress: 2 } : kind === "allowance" ? { status: "paid" } : ["chores", "schoolTasks", "groceries"].includes(kind) ? { done: true } : {}) };
        assert.equal((await call(child, "PATCH", `/records/${recordId}`, { data: changed })).status, 200);
        assert.equal((await snapshot(parent))[kind].find((r: any) => r.id === recordId).title, changed.title);
        assert.equal((await call(otherParent, "PATCH", `/records/${recordId}`, { data: changed })).status, 404);
        assert.equal((await call(otherParent, "DELETE", `/records/${recordId}`)).status, 404);
        assert.equal((await snapshot(otherParent))[kind].some((r: any) => r.id === recordId), false);
        assert.equal((await call(child, "DELETE", `/records/${recordId}`)).status, 204);
        assert.equal((await snapshot(parent))[kind].some((r: any) => r.id === recordId), false);
      }
    });
    await t.test("saved grocery favorites survive list removal and can be reused by either account", async () => {
      const favoriteId = await create(child, "groceryFavorites", { title: "Apples", quantity: "6" });
      const groceryId = await create(parent, "groceries", { title: "Apples", quantity: "6", done: false });
      assert.equal((await call(child, "PATCH", `/records/${groceryId}`, { data: { title: "Apples", quantity: "6", done: true } })).status, 200);
      assert.equal((await snapshot(parent)).groceries.find((r: any) => r.id === groceryId).done, true);
      assert.equal((await call(child, "DELETE", `/records/${groceryId}`)).status, 204);
      assert.equal((await snapshot(parent)).groceryFavorites.find((r: any) => r.id === favoriteId).quantity, "6");
      const reused = await create(child, "groceries", { title: "Apples", quantity: "6", done: false });
      assert.equal((await snapshot(parent)).groceries.find((r: any) => r.id === reused).done, false);
      assert.equal((await call(parent, "DELETE", `/records/${favoriteId}`)).status, 204);
      assert.equal((await snapshot(child)).groceries.some((r: any) => r.id === reused), true);
      assert.equal((await call(child, "POST", "/records", { kind: "groceries", data: { title: " ", quantity: "", done: false } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "groceryFavorites", data: { title: "Milk", quantity: "x".repeat(101) } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "groceries", data: { title: "Milk", quantity: "", done: false, authorId: parentId } })).status, 400);
    });
    await t.test("mood history can distinguish own entries from shared household entries", async () => {
      const childEntry = await create(child, "journal", { promptId: "p2", body: "Child mood history", mood: "sad" });
      const parentEntry = await create(parent, "journal", { promptId: "p1", body: "Parent mood history", mood: "happy" });
      const householdMemberEntry = await create(addedHouseholdMember, "journal", { promptId: "p2", body: "Household member mood history", mood: "sad" });
      const ownMoods = (state: any) => state.journal.filter((entry: any) => entry.authorId === state.activeId && entry.mood);
      assert.ok(ownMoods(await snapshot(child)).some((entry: any) => entry.id === childEntry));
      assert.equal((await snapshot(parent)).journal.some((entry: any) => entry.id === childEntry), false);
      assert.ok(ownMoods(await snapshot(addedHouseholdMember)).some((entry: any) => entry.id === householdMemberEntry));
      assert.equal((await snapshot(parent)).journal.some((entry: any) => entry.id === householdMemberEntry), false);
      assert.equal((await call(parent, "PATCH", `/records/${householdMemberEntry}`, { data: { promptId: "p2", body: "Parent cannot edit this", mood: "happy" } })).status, 404);
      assert.equal((await call(addedParent, "PATCH", `/records/${householdMemberEntry}`, { data: { promptId: "p2", body: "Another parent cannot edit this", mood: "happy" } })).status, 404);
      assert.equal((await call(addedHouseholdMember, "PATCH", `/records/${householdMemberEntry}`, { data: { promptId: "p2", body: "Household member mood history", mood: "sad", shared: true } })).status, 200);
      assert.equal((await call(child, "PATCH", `/records/${childEntry}`, { data: { promptId: "p2", body: "Child mood history", mood: "sad", shared: true } })).status, 200);
      assert.equal((await call(parent, "PATCH", `/records/${parentEntry}`, { data: { promptId: "p1", body: "Parent mood history", mood: "happy", shared: true } })).status, 200);
      const childState = await snapshot(child);
      const parentState = await snapshot(parent);
      const householdMemberState = await snapshot(addedHouseholdMember);
      assert.ok(parentState.journal.some((entry: any) => entry.id === householdMemberEntry));
      assert.equal(ownMoods(parentState).some((entry: any) => entry.id === householdMemberEntry), false);
      assert.equal(ownMoods(householdMemberState).some((entry: any) => entry.id === parentEntry), false);
      assert.ok(childState.journal.some((entry: any) => entry.id === parentEntry));
      assert.ok(parentState.journal.some((entry: any) => entry.id === childEntry));
      assert.equal(ownMoods(childState).some((entry: any) => entry.id === parentEntry), false);
      assert.equal(ownMoods(parentState).some((entry: any) => entry.id === childEntry), false);
      assert.equal((await call(addedHouseholdMember, "PATCH", `/records/${householdMemberEntry}`, { data: { promptId: "p2", body: "Household member mood history", mood: "sad", shared: false } })).status, 200);
      assert.equal((await snapshot(parent)).journal.some((entry: any) => entry.id === householdMemberEntry), false);
      assert.equal((await call(addedHouseholdMember, "DELETE", `/records/${householdMemberEntry}`)).status, 204);
      assert.equal((await call(child, "DELETE", `/records/${childEntry}`)).status, 204);
      assert.equal((await call(parent, "DELETE", `/records/${parentEntry}`)).status, 204);
    });
    await t.test("notifications record other-member changes with isolated persistent read status", async () => {
      const title = `Notification groceries ${randomUUID()}`;
      const grocery = { title, quantity: "1", done: false };
      const groceryId = await create(parent, "groceries", grocery);
      assert.equal((await snapshot(parent)).notifications.some((n: any) => n.summary.includes(title)), false);
      const createdNotice = (await snapshot(child)).notifications.find((n: any) => n.summary.includes(title));
      assert.equal(createdNotice.actorId, parentId);
      assert.equal(createdNotice.readAt, null);
      assert.equal(createdNotice.targetPath, "/groceries");
      const memberNotice = (await snapshot(addedHouseholdMember)).notifications.find((n: any) => n.summary.includes(title));
      assert.equal(memberNotice.actorId, parentId);
      assert.equal(memberNotice.readAt, null);
      assert.equal((await snapshot(addedParent)).notifications.some((n: any) => n.summary.includes(title)), true);
      assert.equal((await snapshot(otherParent)).notifications.some((n: any) => n.summary.includes(title)), false);
      assert.equal((await call(parent, "PATCH", "/notifications/read", { ids: [createdNotice.id] })).status, 204);
      assert.equal((await call(otherParent, "PATCH", "/notifications/read", { ids: [createdNotice.id] })).status, 204);
      assert.equal((await snapshot(child)).notifications.find((n: any) => n.id === createdNotice.id).readAt, null);
      assert.equal((await snapshot(addedHouseholdMember)).notifications.find((n: any) => n.id === memberNotice.id).readAt, null);
      assert.equal((await call(child, "PATCH", "/notifications/read", { ids: [createdNotice.id] })).status, 204);
      const readAt = (await snapshot(child)).notifications.find((n: any) => n.id === createdNotice.id).readAt;
      assert.ok(readAt);
      assert.equal((await call(addedHouseholdMember, "PATCH", "/notifications/read", { ids: [memberNotice.id] })).status, 204);
      assert.ok((await snapshot(addedHouseholdMember)).notifications.find((n: any) => n.id === memberNotice.id).readAt);
      assert.equal((await call(child, "PATCH", "/notifications/read", { ids: [createdNotice.id] })).status, 204);
      assert.equal((await snapshot(child)).notifications.find((n: any) => n.id === createdNotice.id).readAt, readAt);
      assert.equal((await call(child, "PATCH", `/records/${groceryId}`, { data: { ...grocery, done: true } })).status, 200);
      const completed = (await snapshot(parent)).notifications.filter((n: any) => n.summary.includes(title));
      assert.equal(completed.length, 1);
      assert.equal(completed[0].summary, `completed a grocery item: ${title}`);
      assert.equal(completed[0].actorId, childId);
      assert.equal((await call(child, "PATCH", `/records/${groceryId}`, { data: { ...grocery, done: true } })).status, 200);
      assert.equal((await snapshot(parent)).notifications.filter((n: any) => n.summary.includes(title)).length, 1);
      assert.equal((await call(parent, "DELETE", `/records/${groceryId}`)).status, 204);
      assert.ok((await snapshot(child)).notifications.some((n: any) => n.summary === `removed a grocery item: ${title}`));
      assert.equal((await snapshot(parent)).notifications.every((n: any) => n.actorId !== parentId), true);
      assert.equal((await snapshot(child)).notifications.every((n: any) => n.actorId !== childId), true);
      for (const body of [{ ids: [] }, { ids: ["invalid"] }, { ids: [createdNotice.id], recipientId: parentId }]) {
        assert.equal((await call(child, "PATCH", "/notifications/read", body)).status, 400);
      }
      assert.equal((await call(null, "PATCH", "/notifications/read", { ids: [createdNotice.id] })).status, 401);
      assert.equal((await call(child, "POST", "/records", { kind: "notifications", data: { summary: "Forged" } })).status, 400);
      assert.equal((await call(parent, "PATCH", `/records/${moneyId}`, { data: { ...moneyData, title } })).status, 200);
      assert.equal((await snapshot(child)).notifications.some((n: any) => n.targetPath === "/money"), false);
      assert.equal((await db.select().from(nestNotifications).where(eq(nestNotifications.recordId, moneyId))).length, 0);
    });
    await t.test("journal notifications have no previews and withdraw when sharing access ends", async () => {
      const privateBody = `Private journal ${randomUUID()}`;
      const entryData = { promptId: "p2", body: privateBody, mood: "sad" };
      const entryId = await create(parent, "journal", entryData);
      const targetPath = `/journal?entry=${entryId}`;
      assert.equal((await snapshot(child)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, body: `${privateBody} edited` } })).status, 200);
      assert.equal((await snapshot(child)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: true } })).status, 200);
      const shareNotice = (await snapshot(child)).notifications.find((n: any) => n.targetPath === targetPath);
      assert.equal(shareNotice.summary, "shared a journal entry");
      assert.equal((await snapshot(parent)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await snapshot(otherParent)).notifications.some((n: any) => n.targetPath === targetPath), false);
      const replyBody = `Sensitive reply ${randomUUID()}`;
      const replyId = await create(child, "journalReplies", { entryId, body: replyBody });
      assert.equal((await snapshot(parent)).notifications.find((n: any) => n.targetPath === targetPath).summary, "replied to a shared journal entry");
      assert.equal((await call(child, "PATCH", `/records/${replyId}`, { data: { entryId, body: `${replyBody} edited` } })).status, 200);
      assert.ok((await snapshot(parent)).notifications.some((n: any) => n.targetPath === targetPath && n.summary.startsWith("edited a reply")));
      assert.equal((await call(child, "DELETE", `/records/${replyId}`)).status, 204);
      assert.ok((await snapshot(parent)).notifications.some((n: any) => n.targetPath === targetPath && n.summary.startsWith("removed a reply")));
      for (const user of [parent, child]) {
        assert.equal((await snapshot(user)).notifications.some((n: any) => n.summary.includes(privateBody) || n.summary.includes(replyBody) || n.summary.includes("sad")), false);
      }
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: false } })).status, 200);
      assert.equal((await snapshot(child)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await snapshot(parent)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await call(child, "POST", "/records", { kind: "journalReplies", data: { entryId, body: "Rejected reply" } })).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${entryId}`, { data: { ...entryData, shared: true } })).status, 200);
      const reshared = (await snapshot(child)).notifications.filter((n: any) => n.targetPath === targetPath);
      assert.equal(reshared.length, 2);
      assert.ok(reshared.some((n: any) => n.id !== shareNotice.id && n.readAt === null));
      assert.equal((await call(parent, "DELETE", `/records/${entryId}`)).status, 204);
      assert.equal((await snapshot(child)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await snapshot(parent)).notifications.some((n: any) => n.targetPath === targetPath), false);
      assert.equal((await db.select().from(nestNotifications).where(eq(nestNotifications.entryId, entryId))).length, 0);
    });
    await t.test("journal files persist with entry permissions and cannot be forged or moved", async () => {
      const bytes = Buffer.from("89504e470d0a1a0a", "hex");
      const upload = (user: string | null, name: string, body: Buffer = bytes) => fetch(`${origin}/api/nest/attachments?name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { ...(user ? { "x-test-user": user } : {}), "Content-Type": "application/octet-stream" }, body: new Uint8Array(body),
      });
      const read = (user: string | null, id: string, download = false) => fetch(`${origin}/api/nest/attachments/${id}${download ? "/download" : ""}`, { headers: user ? { "x-test-user": user } : {} });
      assert.equal((await upload(null, "image.png")).status, 401);
      assert.equal((await upload(outsider, "image.png")).status, 403);
      assert.equal((await upload(parent, "bad.png", Buffer.from("not an image"))).status, 415);
      assert.equal((await upload(parent, "bad.html", Buffer.from("<html/>"))).status, 415);
      assert.equal((await upload(parent, "empty.txt", Buffer.alloc(0))).status, 400);
      assert.equal((await upload(parent, "large.txt", Buffer.alloc(10485761))).status, 413);
      const response = await upload(child, "photo.png");
      assert.equal(response.status, 201);
      const image = await response.json() as any;
      assert.equal(image.contentType, "image/png");
      assert.equal(image.size, bytes.length);
      assert.equal((await read(child, image.id)).status, 200);
      assert.equal((await read(parent, image.id)).status, 404);
      assert.equal((await call(parent, "DELETE", `/attachments/${image.id}`)).status, 204);
      assert.equal((await read(child, image.id)).status, 200);
      assert.equal((await call(parent, "POST", "/records", { kind: "journal", data: { promptId: "p1", body: "", attachmentIds: [image.id] } })).status, 400);
      assert.equal((await call(child, "POST", "/records", { kind: "journal", data: { promptId: "p1", body: "", attachmentIds: [] } })).status, 400);
      const entryData = { promptId: "p1", body: "", attachmentIds: [image.id] };
      const entry = await create(child, "journal", entryData);
      const own = (await snapshot(child)).journal.find((a: any) => a.id === entry);
      assert.deepEqual(own.attachments, [image]);
      assert.equal((await call(child, "DELETE", `/attachments/${image.id}`)).status, 204);
      assert.equal((await read(child, image.id)).status, 200);
      assert.equal((await read(parent, image.id)).status, 404);
      assert.equal((await read(otherParent, image.id)).status, 404);
      assert.equal((await read(null, image.id)).status, 401);
      assert.equal((await call(child, "POST", "/records", { kind: "journal", data: entryData })).status, 400);
      assert.equal((await call(child, "PATCH", `/records/${entry}`, { data: { ...entryData, shared: true } })).status, 200);
      const sharedImage = await read(parent, image.id);
      assert.equal(sharedImage.status, 200);
      assert.equal(sharedImage.headers.get("content-type"), "image/png");
      assert.equal(sharedImage.headers.get("cache-control"), "no-store");
      assert.equal(sharedImage.headers.get("x-content-type-options"), "nosniff");
      assert.equal(sharedImage.headers.get("content-disposition")?.startsWith("inline;"), true);
      assert.equal((await read(parent, image.id, true)).headers.get("content-disposition")?.startsWith("attachment;"), true);
      assert.deepEqual(Buffer.from(await sharedImage.arrayBuffer()), bytes);
      assert.deepEqual((await snapshot(parent)).journal.find((a: any) => a.id === entry).attachments, [image]);
      assert.equal((await call(parent, "PATCH", `/records/${entry}`, { data: { ...entryData, attachmentIds: [] } })).status, 404);
      assert.equal((await call(child, "PATCH", `/records/${entry}`, { data: { promptId: "p1", body: "Legacy edit", shared: false } })).status, 200);
      assert.deepEqual((await snapshot(child)).journal.find((a: any) => a.id === entry).attachmentIds, [image.id]);
      assert.equal((await read(parent, image.id)).status, 404);
      const pdfResponse = await upload(child, "notes.pdf", Buffer.from("%PDF-1.4\nTest"));
      assert.equal(pdfResponse.status, 201);
      const pdf = await pdfResponse.json() as any;
      assert.equal((await call(child, "PATCH", `/records/${entry}`, { data: { ...entryData, attachmentIds: [pdf.id] } })).status, 200);
      assert.equal((await read(child, image.id)).status, 404);
      assert.equal(stored.has(image.id), false);
      assert.equal((await read(child, pdf.id)).headers.get("content-disposition")?.startsWith("attachment;"), true);
      assert.equal((await call(child, "PATCH", `/records/${entry}`, { data: { ...entryData, attachmentIds: [pdf.id, pdf.id] } })).status, 400);
      assert.equal((await call(child, "PATCH", `/records/${entry}`, { data: { ...entryData, attachmentIds: Array.from({ length: 11 }, () => randomUUID()) } })).status, 400);
      assert.equal((await call(child, "DELETE", `/records/${entry}`)).status, 204);
      assert.equal((await read(child, pdf.id)).status, 404);
      assert.equal(stored.has(pdf.id), false);
      assert.equal((await read(child, "-".repeat(36))).status, 404);
      const staged = await (await upload(child, "draft.txt", Buffer.from("Draft file"))).json() as any;
      assert.equal((await call(child, "DELETE", `/attachments/${staged.id}`)).status, 204);
      assert.equal((await read(child, staged.id)).status, 404);
      assert.equal(stored.has(staged.id), false);
      const memberBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 3, 2, 1]);
      const memberUpload = await upload(addedHouseholdMember, "private-member.png", memberBytes);
      assert.equal(memberUpload.status, 201);
      const memberImage = await memberUpload.json() as any;
      const memberEntry = await create(addedHouseholdMember, "journal", { promptId: "p1", body: "", attachmentIds: [memberImage.id] });
      assert.equal((await read(addedParent, memberImage.id)).status, 404);
      assert.equal((await read(parent, memberImage.id)).status, 404);
      assert.equal((await call(addedParent, "PATCH", `/records/${memberEntry}`, { data: { promptId: "p1", body: "Not yours", attachmentIds: [memberImage.id] } })).status, 404);
      assert.deepEqual((await snapshot(addedHouseholdMember)).journal.find((entry: any) => entry.id === memberEntry).attachments, [memberImage]);
      assert.equal((await call(addedHouseholdMember, "PATCH", `/records/${memberEntry}`, { data: { promptId: "p1", body: "", attachmentIds: [memberImage.id], shared: true } })).status, 200);
      assert.equal((await read(addedParent, memberImage.id)).status, 200);
      assert.equal((await call(addedHouseholdMember, "PATCH", `/records/${memberEntry}`, { data: { promptId: "p1", body: "", attachmentIds: [memberImage.id], shared: false } })).status, 200);
      assert.equal((await read(addedParent, memberImage.id)).status, 404);
      assert.equal((await call(addedHouseholdMember, "DELETE", `/records/${memberEntry}`)).status, 204);
      assert.equal((await read(addedHouseholdMember, memberImage.id)).status, 404);
      assert.equal(stored.has(memberImage.id), false);
    });
    await t.test("validation rejects cross-household references and forged metadata", async () => {
      assert.equal((await call(parent, "POST", "/records", { kind: "goals", data: { title: "Bad ref", memberId: otherId, progress: 0, targetDate: "2026-10-03" } })).status, 400);
      assert.equal((await call(parent, "POST", "/records", { kind: "money", data: { ...moneyData, createdAt: "2000-01-01" } })).status, 400);
      assert.equal((await call(parent, "PATCH", `/members/${otherId}`, { name: "Intruder" })).status, 404);
      assert.equal((await call(parent, "PATCH", `/records/${moneyId}`, { data: { ...moneyData, amount: -1 } })).status, 400);
      assert.equal((await call(parent, "PATCH", `/records/${moneyId}`, { data: { ...moneyData, date: "2026-02-30" } })).status, 400);
      assert.equal((await call(otherParent, "PATCH", `/records/${moneyId}`, { data: moneyData })).status, 404);
      assert.equal((await snapshot(parent)).journal[0].authorId, parentId);
      assert.equal((await snapshot(parent)).journal[0].createdAt.slice(0, 4), String(new Date().getFullYear()));
    });
    await t.test("parents can safely change roles and remove a member without exposing private history", async () => {
      const onlyParent = (await snapshot(otherParent)).activeId;
      assert.equal((await call(otherParent, "PATCH", `/members/${onlyParent}`, { role: "child" })).status, 409);
      assert.equal((await call(otherParent, "DELETE", `/members/${onlyParent}`)).status, 409);

      const profile = (await call(parent, "POST", "/members", { name: "Changing Role", role: "child" })).data;
      const oldCode = await call(parent, "POST", "/invitations", { memberId: profile.id });
      assert.equal(oldCode.status, 201);
      assert.equal((await call(parent, "PATCH", `/members/${profile.id}`, { role: "parent" })).status, 200);
      const roleUser = `test-role-user-${randomUUID()}`;
      assert.equal((await call(roleUser, "POST", "/join", { code: oldCode.data.code })).status, 400);
      const replacement = await call(parent, "POST", "/invitations", { memberId: profile.id });
      assert.equal(replacement.status, 201);
      assert.equal((await call(roleUser, "POST", "/join", { code: replacement.data.code })).status, 200);
      assert.equal((await snapshot(roleUser)).role, "parent");
      assert.equal((await call(parent, "PATCH", `/members/${profile.id}`, { role: "child" })).status, 200);
      assert.equal((await snapshot(roleUser)).role, "child");

      const choreId = await create(parent, "chores", {
        title: "Keep this assigned chore", assignedTo: profile.id, cadence: "Weekly", dueDate: "2026-10-12", done: false,
      });
      const taskId = await create(parent, "schoolTasks", {
        title: "Keep this assigned task", memberId: profile.id, dueDate: "2026-10-12", course: "Project", done: false,
      });
      const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");
      const upload = async (user: string, name: string) => {
        const response = await fetch(`${origin}/api/nest/attachments?name=${encodeURIComponent(name)}`, {
          method: "POST", headers: { "x-test-user": user, "Content-Type": "application/octet-stream" }, body: imageBytes,
        });
        assert.equal(response.status, 201);
        return await response.json() as { id: string };
      };
      const privateFile = await upload(roleUser, "private.png");
      const sharedFile = await upload(roleUser, "shared.png");
      const stagedFile = await upload(roleUser, "unsaved.png");
      const privateEntryId = await create(roleUser, "journal", {
        promptId: "p1", body: "Private words stay private", mood: "sad", attachmentIds: [privateFile.id],
      });
      const sharedEntryId = await create(roleUser, "journal", {
        promptId: "p2", body: "A deliberately shared note", mood: "happy", attachmentIds: [sharedFile.id],
      });
      assert.equal((await call(roleUser, "PATCH", `/records/${sharedEntryId}`, { data: {
        promptId: "p2", body: "A deliberately shared note", mood: "happy", attachmentIds: [sharedFile.id], shared: true,
      } })).status, 200);
      const activeBeforeRemoval = await snapshot(roleUser);
      assert.equal(activeBeforeRemoval.journal.some((entry: any) => entry.id === privateEntryId && entry.mood === "sad"), true);
      const draft = await call(roleUser, "PUT", `/paste-drafts/${activeBeforeRemoval.activeId}/groceries`, {
        revision: null,
        session: { text: "private unsaved list", drafts: [], reviewing: false, savedCount: 0, showErrors: false, error: "", uncertainId: null, finished: false },
      });
      assert.equal(draft.status, 200);
      assert.equal((await snapshot(parent)).chores.some((item: any) => item.id === choreId && item.assignedTo === profile.id), true);

      const pendingProfile = (await call(parent, "POST", "/members", { name: "Pending Removal", role: "householdMember" })).data;
      const pendingInvite = await call(parent, "POST", "/invitations", { memberId: pendingProfile.id });
      assert.equal(pendingInvite.status, 201);
      assert.equal((await call(parent, "DELETE", `/members/${profile.id}`)).status, 204);
      assert.equal((await call(parent, "DELETE", `/members/${pendingProfile.id}`)).status, 204);
      assert.equal((await call(`test-revoked-${randomUUID()}`, "POST", "/join", { code: pendingInvite.data.code })).status, 400);
      assert.equal((await call(roleUser, "GET", "/snapshot")).status, 404);

      const afterRemoval = await snapshot(parent);
      assert.equal(afterRemoval.members.some((member: any) => member.id === profile.id || member.id === pendingProfile.id), false);
      assert.equal(afterRemoval.journal.some((entry: any) => entry.id === privateEntryId), false);
      assert.equal(afterRemoval.journal.some((entry: any) => entry.id === sharedEntryId && entry.mood === "happy"), true);
      assert.equal(afterRemoval.chores.some((item: any) => item.id === choreId && item.assignedTo === profile.id), true);
      assert.equal(afterRemoval.schoolTasks.some((item: any) => item.id === taskId && item.memberId === profile.id), true);
      assert.equal((await call(parent, "PATCH", `/records/${choreId}`, { data: {
        title: "Keep this assigned chore", assignedTo: profile.id, cadence: "Weekly", dueDate: "2026-10-12", done: false,
      } })).status, 200);
      assert.equal((await call(parent, "POST", "/records", { kind: "chores", data: {
        title: "Do not assign to removed profile", assignedTo: profile.id, cadence: "Weekly", dueDate: "2026-10-12", done: false,
      } })).status, 400);
      const readAttachment = (user: string, fileId: string) => fetch(`${origin}/api/nest/attachments/${fileId}`, { headers: { "x-test-user": user } });
      assert.equal((await readAttachment(parent, privateFile.id)).status, 404);
      assert.equal((await readAttachment(parent, sharedFile.id)).status, 200);
      assert.equal(stored.has(privateFile.id), true);
      assert.equal(stored.has(sharedFile.id), true);
      assert.equal(stored.has(stagedFile.id), false);
      const [retainedPrivateJournal] = await db.select().from(nestRecords).where(eq(nestRecords.id, privateEntryId));
      assert.equal(retainedPrivateJournal.shared, false);
      assert.equal(retainedPrivateJournal.data.mood, "sad");
      assert.equal((await db.select().from(nestAttachments).where(eq(nestAttachments.id, privateFile.id))).length, 1);
      assert.equal((await db.select().from(nestAttachments).where(eq(nestAttachments.id, stagedFile.id))).length, 0);
      assert.equal((await db.select().from(nestPasteDrafts).where(eq(nestPasteDrafts.ownerId, profile.id))).length, 0);
      assert.equal((await db.select().from(nestNotifications).where(or(
        eq(nestNotifications.actorId, profile.id), eq(nestNotifications.recipientId, profile.id),
      ))).length, 0);
      const [removed] = await db.select().from(nestMembers).where(eq(nestMembers.id, profile.id));
      assert.equal(removed.authUserId, null);
      assert.ok(removed.removedAt);
    });
  } finally {
    for (const householdId of houses) {
      await db.transaction(async (tx) => {
        await tx.delete(nestRecords).where(eq(nestRecords.householdId, householdId));
        await tx.delete(nestInvitations).where(eq(nestInvitations.householdId, householdId));
        await tx.delete(nestMembers).where(eq(nestMembers.householdId, householdId));
        await tx.delete(nestHouseholds).where(eq(nestHouseholds.id, householdId));
      });
    }
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await pool.end();
  }
});
