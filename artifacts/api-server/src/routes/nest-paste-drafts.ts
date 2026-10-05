import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, nestMembers, nestPasteDrafts, nestRecords, type NestMember } from "@workspace/db";
import {
  GetNestPasteDraftParams, GetNestPasteDraftResponse,
  PutNestPasteDraftBody, SaveNestPasteDraftRowBody,
} from "@workspace/api-zod";
import { recordSchemas } from "../lib/nest-policy";
import { notifyRecordChange } from "../lib/nest-notifications";

export function createPasteDraftRouter(membership: (req: Request) => Promise<NestMember | undefined>) {
  const router = Router();
  const path = "/nest/paste-drafts/:membershipId/:kind";
  const validInput = PutNestPasteDraftBody.strict().refine(({ session: s }) => !s || (
    new Set(s.drafts.map((r) => r.id)).size === s.drafts.length
    && (s.uncertainId === null || s.drafts.some((r) => r.id === s.uncertainId))
    && (!s.finished || (s.drafts.length === 0 && s.uncertainId === null))
  ), "Invalid draft state");

  router.get(path, async (req, res): Promise<void> => {
    const params = GetNestPasteDraftParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: "Invalid draft." }); return; }
    const member = await membership(req);
    if (!member || member.id !== params.data.membershipId) { res.status(403).json({ error: "Draft unavailable for this account and household." }); return; }
    const [draft] = await db.select().from(nestPasteDrafts).where(and(
      eq(nestPasteDrafts.ownerId, member.id), eq(nestPasteDrafts.householdId, member.householdId),
      eq(nestPasteDrafts.accountId, member.authUserId!), eq(nestPasteDrafts.kind, params.data.kind),
    ));
    res.json(GetNestPasteDraftResponse.parse({ revision: draft?.revision ?? null, session: draft?.session ?? null }));
  });

  // Serializing on the membership also protects the initially absent slot.
  // Never physically delete slots: a tombstone rejects stale writers.
  for (const action of ["put", "save"] as const) {
    router[action === "put" ? "put" : "post"](action === "put" ? path : `${path}/save`, async (req, res): Promise<void> => {
      const params = GetNestPasteDraftParams.safeParse(req.params);
      const input = action === "put" ? validInput.safeParse(req.body) : SaveNestPasteDraftRowBody.strict().safeParse(req.body);
      if (!params.success || !input.success) { res.status(400).json({ error: "Invalid draft. Keep text under 20,000 characters and lists under 200 rows." }); return; }
      const member = await membership(req);
      if (!member || member.id !== params.data.membershipId) { res.status(403).json({ error: "Draft unavailable for this account and household." }); return; }
      const result = await db.transaction(async (tx) => {
        const [owner] = await tx.select().from(nestMembers).where(and(
          eq(nestMembers.id, member.id), eq(nestMembers.householdId, member.householdId),
          eq(nestMembers.authUserId, member.authUserId!), isNull(nestMembers.removedAt),
        )).for("update");
        if (!owner) return { status: 403, error: "Membership unavailable." };
        const where = and(
          eq(nestPasteDrafts.ownerId, owner.id), eq(nestPasteDrafts.householdId, owner.householdId),
          eq(nestPasteDrafts.accountId, owner.authUserId!), eq(nestPasteDrafts.kind, params.data.kind),
        );
        const [draft] = await tx.select().from(nestPasteDrafts).where(where).for("update");
        if ((draft?.revision ?? null) !== input.data.revision) return { status: 409, error: "Another device changed this draft. Load the latest draft before continuing." };
        let session;
        if (action === "put") {
          session = validInput.parse(req.body).session;
        } else {
          const { rowId } = SaveNestPasteDraftRowBody.parse(req.body);
          const s = GetNestPasteDraftResponse.parse({ revision: draft?.revision, session: draft?.session }).session;
          const row = s?.drafts.find((r) => r.id === rowId);
          if (!s || !row || s.uncertainId !== rowId || !s.reviewing || s.finished) return { status: 409, error: "Load the latest draft before saving." };
          const payload = params.data.kind === "groceries"
            ? { title: row.title, quantity: row.quantity, done: false }
            : { title: row.title, assignedTo: row.assignedTo, cadence: row.cadence, dueDate: row.dueDate, done: false, isPaid: row.isPaid ?? false, payAmount: row.isPaid ? Number(row.payAmount) : 0 };
          const parsed = recordSchemas[params.data.kind].safeParse(payload);
          if (!parsed.success || /[\r\n]/.test(row.title)) return { status: 400, error: "Fix this reviewed row before saving." };
          if (params.data.kind === "chores" && row.assignedTo !== "household") {
            const [target] = await tx.select().from(nestMembers).where(and(
              eq(nestMembers.id, row.assignedTo), eq(nestMembers.householdId, owner.householdId),
              isNull(nestMembers.removedAt),
            ));
            if (!target) return { status: 400, error: "Choose a household member." };
          }
          const [record] = await tx.insert(nestRecords).values({
            householdId: owner.householdId, authorId: owner.id, kind: params.data.kind, data: parsed.data,
          }).returning();
          await notifyRecordChange(tx, owner, record, "added");
          const remaining = s.drafts.filter((r) => r.id !== rowId);
          session = { ...s, drafts: remaining, savedCount: s.savedCount + 1, uncertainId: null, error: "", finished: remaining.length === 0 };
        }
        const revision = randomUUID();
        if (draft) await tx.update(nestPasteDrafts).set({ revision, session }).where(where);
        else await tx.insert(nestPasteDrafts).values({
          householdId: owner.householdId, ownerId: owner.id, accountId: owner.authUserId!, kind: params.data.kind, revision, session,
        });
        return { status: 200, value: { revision, session } };
      });
      if (result.value) res.json(GetNestPasteDraftResponse.parse(result.value));
      else res.status(result.status).json({ error: result.error });
    });
  }
  return router;
}