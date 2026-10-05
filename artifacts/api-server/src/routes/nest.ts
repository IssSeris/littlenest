import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, ne, or, asc, desc, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, nestHouseholds, nestMembers, nestInvitations, nestRecords, nestNotifications, nestAttachments, nestPasteDrafts, type NestMember } from "@workspace/db";
import {
  CreateNestHouseholdBody, CreateNestMemberBody, CreateNestInvitationBody, JoinNestHouseholdBody, CreateNestRecordBody,
  UpdateNestRecordBody, UpdateNestRecordParams, DeleteNestRecordParams,
  UpdateNestMemberBody, UpdateNestMemberParams, GetNestSnapshotResponse,
  CreateNestMemberResponse, CreateNestInvitationResponse, CreateNestHouseholdResponse, JoinNestHouseholdResponse,
  CreateNestRecordResponse, UpdateNestRecordResponse, UpdateNestMemberResponse,
  MarkNestNotificationsReadBody,
} from "@workspace/api-zod";
import { canWriteRecord, recordSchemas } from "../lib/nest-policy";
import { getClerkProxyHost } from "../middlewares/clerkProxyMiddleware";
import { notifyMembers, notifyRecordChange, type NestTransaction } from "../lib/nest-notifications";
import { journalStorage, type JournalStorage } from "../lib/journal-storage";
import { createAttachmentRouter, attachmentMetadata, bindJournalAttachments, JournalAttachmentError, removeStoredAttachments } from "./nest-attachments";
import { createPasteDraftRouter } from "./nest-paste-drafts";
import { ChorePaymentError, choreAllowanceRecorded, prepareChoreWrite } from "../lib/nest-chore-allowance";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
const joinAttempts = new Map<string, { count: number; resetAt: number }>();

const isUniqueViolation = (error: unknown) => {
  const value = error as { code?: string; cause?: { code?: string } };
  return value.code === "23505" || value.cause?.code === "23505";
};
export function createNestRouter(identity: (req: Request) => string | null = (req) => getAuth(req).userId, storage: JournalStorage = journalStorage): Router {
  const router = Router();
  router.use("/nest", (req, res, next) => {
    if (!identity(req)) {
      if (process.env.PASTE_BROWSER_CI_ROUTER === "1") {
        const cookies = req.headers.cookie ?? "";
        res.setHeader("x-little-nest-ci-auth", JSON.stringify({
          host: req.headers.host ?? null,
          browserHost: getClerkProxyHost(req) ?? null,
          origin: req.get("origin") ?? null,
          hasCookie: Boolean(cookies),
          hasSessionCookie: /(?:^|;\s*)__session=/.test(cookies),
          hasAuthorization: Boolean(req.headers.authorization),
        }));
      }
      res.status(401).json({ error: "Please sign in." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== getClerkProxyHost(req)) {
          res.status(403).json({ error: "Use Little Nest on its own website." }); return;
        }
      } catch { res.status(403).json({ error: "Invalid origin." }); return; }
    }
    next();
  });
  const membership = async (req: Request) => {
    const [member] = await db.select().from(nestMembers).where(and(
      eq(nestMembers.authUserId, identity(req)!), isNull(nestMembers.removedAt),
    ));
    return member;
  };
  // Household administration and member-owned writes serialize on the same
  // household → member lock order so stale requests cannot outlive removal.
  const lockActiveMember = async (tx: NestTransaction, member: NestMember, userId: string) => {
    const [household] = await tx.select({ id: nestHouseholds.id }).from(nestHouseholds)
      .where(eq(nestHouseholds.id, member.householdId)).for("update");
    if (!household) return undefined;
    const [active] = await tx.select().from(nestMembers).where(and(
      eq(nestMembers.id, member.id), eq(nestMembers.householdId, member.householdId),
      eq(nestMembers.authUserId, userId), isNull(nestMembers.removedAt),
    )).for("update");
    return active;
  };
  router.use(createAttachmentRouter(membership, storage));
  router.use(createPasteDraftRouter(membership));

  router.get("/nest/snapshot", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member) { res.status(404).json({ error: "Create or join a household first." }); return; }
    const [household] = await db.select().from(nestHouseholds).where(eq(nestHouseholds.id, member.householdId));
    const members = await db.select().from(nestMembers).where(and(
      eq(nestMembers.householdId, member.householdId), isNull(nestMembers.removedAt),
    )).orderBy(asc(nestMembers.role));
    const visibility = and(
      eq(nestRecords.householdId, member.householdId),
      ne(nestRecords.kind, "journalReplies"),
      member.role !== "parent" ? and(ne(nestRecords.kind, "money"), ne(nestRecords.kind, "budgetPlans")) : undefined,
      or(ne(nestRecords.kind, "journal"), eq(nestRecords.authorId, member.id), eq(nestRecords.shared, true)),
    );
    const records = await db.select().from(nestRecords).where(visibility).orderBy(asc(nestRecords.createdAt));
    const journalIds = records.filter((r) => r.kind === "journal").map((r) => r.id);
    const attachments = journalIds.length ? await db.select().from(nestAttachments).where(and(eq(nestAttachments.householdId, member.householdId), inArray(nestAttachments.entryId, journalIds))) : [];
    const replyEntry = alias(nestRecords, "reply_entry");
    const replies = await db.select({ record: nestRecords }).from(nestRecords).innerJoin(replyEntry, sql`${nestRecords.data}->>'entryId' = ${replyEntry.id}::text`).where(and(
      eq(nestRecords.householdId, member.householdId), eq(nestRecords.kind, "journalReplies"),
      eq(replyEntry.householdId, member.householdId), eq(replyEntry.kind, "journal"), eq(replyEntry.shared, true),
    )).orderBy(asc(nestRecords.createdAt));
    const collections: Record<string, unknown[]> = { chores: [], allowance: [], events: [], budgetPlans: [], schoolTasks: [], goals: [], journal: [], groceries: [], groceryFavorites: [], journalReplies: [] };
    if (member.role === "parent") collections.money = [];
    for (const record of [...records, ...replies.map((row) => row.record)]) {
      const visibleData = { ...record.data };
      delete visibleData._allowanceAwards;
      const item = { ...visibleData, id: record.id, ...(record.kind === "chores" ? {
        isPaid: Boolean(record.data.isPaid), payAmount: Number(record.data.payAmount ?? 0), completedOn: record.data.completedOn ?? null,
        allowanceRecorded: choreAllowanceRecorded(record.data),
      } : {}), ...(["journal", "journalReplies"].includes(record.kind) ? {
        authorId: record.authorId, createdAt: record.createdAt.toISOString(),
      } : {}), ...(record.kind === "journal" ? {
        shared: record.shared,
        attachments: ((record.data.attachmentIds ?? []) as string[]).flatMap((id) => {
          const a = attachments.find((a) => a.id === id && a.entryId === record.id);
          return a ? [attachmentMetadata(a)] : [];
        }),
      } : {}) };
      collections[record.kind]!.push(item);
    }
    const notificationEntry = alias(nestRecords, "notification_entry");
    const notifications = await db.select({ notice: nestNotifications }).from(nestNotifications)
      .leftJoin(notificationEntry, eq(nestNotifications.entryId, notificationEntry.id))
      .where(and(
        eq(nestNotifications.householdId, member.householdId), eq(nestNotifications.recipientId, member.id),
        ne(nestNotifications.actorId, member.id),
        ne(nestNotifications.kind, "money"),
        ne(nestNotifications.kind, "budgetPlans"),
        or(isNull(nestNotifications.entryId), and(
          eq(notificationEntry.householdId, member.householdId), eq(notificationEntry.kind, "journal"), eq(notificationEntry.shared, true),
        )),
      )).orderBy(desc(nestNotifications.createdAt), desc(nestNotifications.id)).limit(50);
    const snapshot = {
      householdName: household.name, activeId: member.id, role: member.role,
      members: members.map((m) => ({ id: m.id, name: m.name, role: m.role, avatarId: m.avatarId, linked: Boolean(m.authUserId), trackingLabel: m.trackingLabel })),
      ...collections,
      notifications: notifications.map(({ notice }) => ({
        id: notice.id, actorId: notice.actorId, summary: notice.summary, targetPath: notice.targetPath,
        createdAt: notice.createdAt.toISOString(), readAt: notice.readAt?.toISOString() ?? null,
      })),
    };
    // Orval's object schema validates the envelope; send original validated domain
    // fields rather than its stripped NestItem projection.
    GetNestSnapshotResponse.parse(snapshot);
    res.json(snapshot);
  });

  router.patch("/nest/notifications/read", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member) { res.status(403).json({ error: "Join a household first." }); return; }
    const input = MarkNestNotificationsReadBody.strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: "Choose valid notifications." }); return; }
    await db.update(nestNotifications).set({ readAt: new Date() }).where(and(
      eq(nestNotifications.householdId, member.householdId), eq(nestNotifications.recipientId, member.id),
      inArray(nestNotifications.id, input.data.ids), isNull(nestNotifications.readAt),
    ));
    res.sendStatus(204);
  });

  router.post("/nest/households", async (req, res): Promise<void> => {
    const parsed = CreateNestHouseholdBody.strict().safeParse(req.body);
    if (!parsed.success || Object.values(parsed.data ?? {}).some((v) => !v.trim())) {
      res.status(400).json({ error: "Enter household and profile names." }); return;
    }
    if (await membership(req)) { res.status(409).json({ error: "Your account already belongs to a household." }); return; }
    try {
      const household = await db.transaction(async (tx) => {
        const [house] = await tx.insert(nestHouseholds).values({ name: parsed.data.name.trim() }).returning();
        await tx.insert(nestMembers).values([
          { householdId: house.id, authUserId: identity(req)!, role: "parent", name: parsed.data.parentName.trim(), avatarId: "animals-01-a" },
          { householdId: house.id, role: "child", name: parsed.data.childName.trim(), avatarId: "reptiles-01-a" },
        ]);
        return house;
      });
      res.status(201).json(CreateNestHouseholdResponse.parse({ id: household.id }));
    } catch (err) {
      if ((err as { code?: string; cause?: { code?: string } }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") {
        res.status(409).json({ error: "Your account already belongs to a household." }); return;
      }
      throw err;
    }
  });

  router.post("/nest/members", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member || member.role !== "parent") { res.status(403).json({ error: "Only a parent can add household members." }); return; }
    const parsed = CreateNestMemberBody.strict().safeParse(req.body);
    const name = parsed.success ? parsed.data.name.trim() : "";
    if (!parsed.success || !name || name.length > 80) {
      res.status(400).json({ error: "Enter a name of 1 to 80 characters and choose a household role." }); return;
    }
    const avatarId = parsed.data.role === "child" ? "reptiles-01-a"
      : parsed.data.role === "householdMember" ? "bugs-01-a" : "animals-01-a";
    const created = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor || actor.role !== "parent") return null;
      const [profile] = await tx.insert(nestMembers).values({
        householdId: member.householdId, role: parsed.data.role, name, avatarId,
      }).returning();
      return profile;
    });
    if (!created) { res.status(403).json({ error: "Your parent membership is no longer available." }); return; }
    res.status(201).json(CreateNestMemberResponse.parse({
      id: created.id, name: created.name, role: created.role, avatarId: created.avatarId,
      linked: Boolean(created.authUserId), trackingLabel: created.trackingLabel,
    }));
  });

  router.post("/nest/invitations", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member || member.role !== "parent") { res.status(403).json({ error: "Only a parent can invite household members." }); return; }
    const parsed = CreateNestInvitationBody.strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Choose a household profile to invite." }); return; }
    const code = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor || actor.role !== "parent") return { error: "unavailable" as const };
      const [target] = await tx.select().from(nestMembers).where(and(
        eq(nestMembers.id, parsed.data.memberId), eq(nestMembers.householdId, member.householdId),
        isNull(nestMembers.removedAt),
      )).for("update");
      if (!target) return { error: "unavailable" as const };
      if (target.authUserId) return { error: "linked" as const };
      await tx.update(nestInvitations).set({ usedAt: new Date() }).where(and(
        eq(nestInvitations.memberId, target.id), isNull(nestInvitations.usedAt),
      ));
      await tx.insert(nestInvitations).values({
        householdId: member.householdId, memberId: target.id, codeHash: hash(code), expiresAt,
      });
      return { target };
    });
    if ("error" in result) {
      if (result.error === "linked") { res.status(409).json({ error: "This profile is already linked to an account." }); return; }
      res.status(404).json({ error: "That profile is not available in your household." }); return;
    }
    res.status(201).json(CreateNestInvitationResponse.parse({
      code, expiresAt: expiresAt.toISOString(), memberId: result.target.id,
    }));
  });

  router.post("/nest/join", async (req, res): Promise<void> => {
    const userId = identity(req)!;
    const attempt = joinAttempts.get(userId);
    if (attempt && attempt.resetAt > Date.now() && attempt.count >= 10) {
      res.status(429).json({ error: "Too many attempts. Please try again in a few minutes." }); return;
    }
    joinAttempts.set(userId, { count: attempt && attempt.resetAt > Date.now() ? attempt.count + 1 : 1, resetAt: attempt && attempt.resetAt > Date.now() ? attempt.resetAt : Date.now() + 5 * 60 * 1000 });
    if (joinAttempts.size > 1000) for (const [key, value] of joinAttempts) if (value.resetAt < Date.now()) joinAttempts.delete(key);
    const parsed = JoinNestHouseholdBody.strict().safeParse(req.body);
    if (!parsed.success || !/^[a-f0-9]{32}$/i.test(parsed.data.code)) { res.status(400).json({ error: "Enter the 32-character invitation code." }); return; }
    if (await membership(req)) { res.status(409).json({ error: "Your account already belongs to a household." }); return; }
    const codeHash = hash(parsed.data.code.toLowerCase());
    const hint = (await db.select().from(nestInvitations).where(eq(nestInvitations.codeHash, codeHash)))[0];
    if (!hint) { res.status(400).json({ error: "That invitation has expired or was already used. Ask the parent for a new code." }); return; }
    try {
      const joined = await db.transaction(async (tx) => {
        // All invitation mutations lock household → profile → invitation.
        // The unlocked lookup above only discovers that lock order; the row is rechecked below.
        const [household] = await tx.select({ id: nestHouseholds.id }).from(nestHouseholds)
          .where(and(eq(nestHouseholds.id, hint.householdId))).for("update");
        if (!household) return { error: "invalid" as const };
        const [target] = hint.memberId ? await tx.select().from(nestMembers).where(and(
          eq(nestMembers.id, hint.memberId), eq(nestMembers.householdId, hint.householdId),
        )).for("update") : [];
        const [invite] = await tx.select().from(nestInvitations).where(and(
          eq(nestInvitations.id, hint.id), eq(nestInvitations.codeHash, codeHash),
        )).for("update");
        if (!invite || invite.memberId !== target?.id || target?.removedAt || invite.usedAt || invite.expiresAt <= new Date()) {
          if (invite && !invite.memberId && !invite.usedAt) {
            await tx.update(nestInvitations).set({ usedAt: new Date() }).where(eq(nestInvitations.id, invite.id));
          }
          return { error: "invalid" as const };
        }
        if (!target) return { error: "invalid" as const };
        if (target.authUserId) return { error: "linked" as const };
        const [existingMembership] = await tx.select({ id: nestMembers.id }).from(nestMembers)
          .where(eq(nestMembers.authUserId, userId)).limit(1);
        if (existingMembership) return { error: "account-linked" as const };
        const [linked] = await tx.update(nestMembers).set({ authUserId: userId }).where(and(
          eq(nestMembers.id, target.id), eq(nestMembers.householdId, hint.householdId), isNull(nestMembers.authUserId),
        )).returning();
        if (!linked) return { error: "linked" as const };
        await tx.update(nestInvitations).set({ usedAt: new Date() }).where(and(
          eq(nestInvitations.id, invite.id), isNull(nestInvitations.usedAt),
        ));
        await notifyMembers(tx, linked, { kind: "household", recordId: linked.id, summary: "joined your household", targetPath: "/" });
        return { memberId: linked.id };
      });
      if ("error" in joined) {
        if (joined.error === "linked") { res.status(409).json({ error: "That household profile is already linked to an account." }); return; }
        if (joined.error === "account-linked") { res.status(409).json({ error: "Your account already belongs to a household." }); return; }
        res.status(400).json({ error: "That invitation has expired or was already used. Ask the parent for a new code." }); return;
      }
      res.json(JoinNestHouseholdResponse.parse({ id: joined.memberId }));
    } catch (error) {
      if (isUniqueViolation(error)) { res.status(409).json({ error: "Your account already belongs to a household." }); return; }
      throw error;
    }
  });

  router.post("/nest/records", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member) { res.status(403).json({ error: "Join a household first." }); return; }
    const input = CreateNestRecordBody.strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: "Invalid item." }); return; }
    const { kind } = input.data;
    if ((kind === "money" || kind === "budgetPlans") && member.role !== "parent") { res.status(403).json({ error: "Money is parent-only." }); return; }
    const parsed = recordSchemas[kind].safeParse(input.data.data);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid item." }); return; }
    let data = { ...parsed.data } as Record<string, unknown>;
    delete data.shared;
    if (kind === "journalReplies") {
      const result = await db.transaction(async (tx) => {
        const actor = await lockActiveMember(tx, member, identity(req)!);
        if (!actor) return { error: "membership" as const };
        const [entry] = await tx.select().from(nestRecords).where(and(eq(nestRecords.id, String(data.entryId)), eq(nestRecords.householdId, member.householdId), eq(nestRecords.kind, "journal"), eq(nestRecords.shared, true))).for("update");
        if (!entry) return { error: "entry" as const };
        const [created] = await tx.insert(nestRecords).values({ householdId: member.householdId, authorId: actor.id, kind, data, shared: false }).returning();
        await notifyRecordChange(tx, actor, created, "added");
        return { record: created };
      });
      if ("error" in result) {
        if (result.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
        res.status(404).json({ error: "This shared journal entry is no longer available." }); return;
      }
      res.status(201).json(CreateNestRecordResponse.parse({ id: result.record.id }));
      return;
    }
    const result = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor) return { error: "membership" as const };
      if ((kind === "money" || kind === "budgetPlans") && actor.role !== "parent") return { error: "parent" as const };
      const ref = data.memberId ?? data.assignedTo;
      if (ref && !(kind === "chores" && ref === "household")) {
        const [target] = await tx.select().from(nestMembers).where(and(
          eq(nestMembers.id, String(ref)), eq(nestMembers.householdId, member.householdId),
          isNull(nestMembers.removedAt),
        ));
        if (!target) return { error: "target" as const };
      }
      if (kind === "budgetPlans") {
        // Serialize first saves so two tabs cannot create separate plans for one month.
        const [existing] = await tx.select({ id: nestRecords.id }).from(nestRecords).where(and(
          eq(nestRecords.householdId, member.householdId), eq(nestRecords.kind, "budgetPlans"),
          sql`${nestRecords.data}->>'month' = ${String(data.month)}`,
        )).limit(1);
        if (existing) return { error: "duplicate" as const };
      }
      const chore = kind === "chores" ? await prepareChoreWrite(tx, actor, data) : { data, allowanceEntry: undefined };
      data = chore.data;
      const [created] = await tx.insert(nestRecords).values({ householdId: member.householdId, authorId: actor.id, kind, data, shared: false }).returning();
      if (kind === "journal") {
        await bindJournalAttachments(tx, actor, created, data);
        await tx.update(nestRecords).set({ data }).where(eq(nestRecords.id, created.id));
      }
      await notifyRecordChange(tx, actor, created, "added");
      return { record: created, allowanceEntry: chore.allowanceEntry };
    });
    if ("error" in result) {
      if (result.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
      if (result.error === "parent") { res.status(403).json({ error: "Money is parent-only." }); return; }
      if (result.error === "target") { res.status(400).json({ error: "Choose someone from your household." }); return; }
      if (result.error === "duplicate") { res.status(409).json({ error: "A budget plan already exists for that month. Refresh the money page and edit the saved plan." }); return; }
    }
    res.status(201).json(CreateNestRecordResponse.parse({ id: result.record.id, allowanceEntry: result.allowanceEntry }));
  });

  router.patch("/nest/records/:id", async (req, res): Promise<void> => {
    const member = await membership(req);
    const params = UpdateNestRecordParams.safeParse(req.params);
    const input = UpdateNestRecordBody.strict().safeParse(req.body);
    if (!params.success || !input.success) { res.status(400).json({ error: "Invalid item." }); return; }
    if (!member) { res.status(403).json({ error: "Join a household first." }); return; }
    const [record] = await db.select().from(nestRecords).where(and(eq(nestRecords.id, params.data.id), eq(nestRecords.householdId, member.householdId)));
    if (!record || !canWriteRecord(member, record)) { res.status(404).json({ error: "Item unavailable." }); return; }
    const parsed = recordSchemas[record.kind].safeParse(input.data.data);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid item." }); return; }
    let data = { ...parsed.data } as Record<string, unknown>;
    if (record.kind === "budgetPlans" && data.month !== record.data.month) { res.status(400).json({ error: "A saved budget plan cannot be moved to another month." }); return; }
    if (record.kind === "journalReplies") {
      if (data.entryId !== record.data.entryId) { res.status(400).json({ error: "A reply cannot be moved to another entry." }); return; }
      const updated = await db.transaction(async (tx) => {
        const actor = await lockActiveMember(tx, member, identity(req)!);
        if (!actor) return { error: "membership" as const };
        const [entry] = await tx.select().from(nestRecords).where(and(eq(nestRecords.id, String(record.data.entryId)), eq(nestRecords.householdId, member.householdId), eq(nestRecords.kind, "journal"), eq(nestRecords.shared, true))).for("update");
        if (!entry) return { error: "entry" as const };
        const [current] = await tx.select().from(nestRecords).where(eq(nestRecords.id, record.id)).for("update");
        if (!current || !canWriteRecord(actor, current)) return { error: "unavailable" as const };
        const [reply] = await tx.update(nestRecords).set({ data }).where(and(eq(nestRecords.id, record.id), eq(nestRecords.authorId, actor.id))).returning();
        if (reply) await notifyRecordChange(tx, actor, reply, "updated", current);
        return reply ? { record: reply } : { error: "unavailable" as const };
      });
      if ("error" in updated) {
        if (updated.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
        res.status(404).json({ error: "This reply is no longer available." }); return;
      }
      res.json(UpdateNestRecordResponse.parse(updated.record));
      return;
    }
    let removedAttachments: string[] = [];
    const updated = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor) return { error: "membership" as const };
      const [current] = await tx.select().from(nestRecords).where(and(eq(nestRecords.id, record.id), eq(nestRecords.householdId, member.householdId))).for("update");
      if (!current || !canWriteRecord(actor, current)) return { error: "unavailable" as const };
      const ref = data.memberId ?? data.assignedTo;
      if (ref && !(current.kind === "chores" && ref === "household")) {
        const [target] = await tx.select().from(nestMembers).where(and(
          eq(nestMembers.id, String(ref)), eq(nestMembers.householdId, member.householdId),
        ));
        const previousRef = current.data.memberId ?? current.data.assignedTo;
        if (!target || (target.removedAt && String(previousRef) !== String(ref))) return { error: "target" as const };
      }
      const chore = current.kind === "chores" ? await prepareChoreWrite(tx, actor, data, current) : { data, allowanceEntry: undefined };
      data = chore.data;
      const shared = current.kind === "journal" && typeof data.shared === "boolean" ? data.shared : current.shared;
      // Omission from older clients preserves mood; explicit null clears it.
      if (current.kind === "journal" && data.mood === undefined && current.data.mood !== undefined) data.mood = current.data.mood;
      if (current.kind === "journal") removedAttachments = await bindJournalAttachments(tx, actor, current, data);
      delete data.shared;
      const [changed] = await tx.update(nestRecords).set({ data, shared }).where(eq(nestRecords.id, current.id)).returning();
      await notifyRecordChange(tx, actor, changed, "updated", current);
      return { id: changed.id, allowanceEntry: chore.allowanceEntry };
    });
    if ("error" in updated) {
      if (updated.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
      if (updated.error === "target") { res.status(400).json({ error: "Choose someone from your household." }); return; }
      res.status(404).json({ error: "Item unavailable." }); return;
    }
    await removeStoredAttachments(storage, removedAttachments);
    res.json(UpdateNestRecordResponse.parse(updated));
  });

  router.delete("/nest/records/:id", async (req, res): Promise<void> => {
    const member = await membership(req);
    const params = DeleteNestRecordParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: "Invalid item." }); return; }
    if (!member) { res.status(403).json({ error: "Join a household first." }); return; }
    const [record] = await db.select().from(nestRecords).where(and(eq(nestRecords.id, params.data.id), eq(nestRecords.householdId, member.householdId)));
    if (!record || !canWriteRecord(member, record)) { res.status(404).json({ error: "Item unavailable." }); return; }
    if (record.kind === "journalReplies") {
      const removed = await db.transaction(async (tx) => {
        const actor = await lockActiveMember(tx, member, identity(req)!);
        if (!actor) return { error: "membership" as const };
        const [entry] = await tx.select().from(nestRecords).where(and(eq(nestRecords.id, String(record.data.entryId)), eq(nestRecords.householdId, member.householdId), eq(nestRecords.kind, "journal"), eq(nestRecords.shared, true))).for("update");
        if (!entry) return { error: "unavailable" as const };
        const [current] = await tx.select().from(nestRecords).where(eq(nestRecords.id, record.id)).for("update");
        if (!current || !canWriteRecord(actor, current)) return { error: "unavailable" as const };
        const [reply] = await tx.delete(nestRecords).where(and(eq(nestRecords.id, record.id), eq(nestRecords.authorId, actor.id))).returning();
        if (reply) await notifyRecordChange(tx, actor, reply, "removed");
        return reply ? { removed: true as const } : { error: "unavailable" as const };
      });
      if ("error" in removed) {
        if (removed.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
        res.status(404).json({ error: "This reply is no longer available." }); return;
      }
      res.sendStatus(204);
      return;
    }
    if (record.kind === "journal") {
      let removedAttachments: string[] = [];
      const removed = await db.transaction(async (tx) => {
        const actor = await lockActiveMember(tx, member, identity(req)!);
        if (!actor) return { error: "membership" as const };
        const [current] = await tx.select().from(nestRecords).where(and(
          eq(nestRecords.id, record.id), eq(nestRecords.householdId, member.householdId),
        )).for("update");
        if (!current || !canWriteRecord(actor, current)) return { error: "unavailable" as const };
        removedAttachments = (await tx.select({ id: nestAttachments.id }).from(nestAttachments).where(eq(nestAttachments.entryId, record.id))).map((a) => a.id);
        await tx.delete(nestRecords).where(and(eq(nestRecords.householdId, member.householdId), eq(nestRecords.kind, "journalReplies"), sql`${nestRecords.data}->>'entryId' = ${record.id}`));
        await tx.delete(nestNotifications).where(and(eq(nestNotifications.householdId, member.householdId), eq(nestNotifications.entryId, record.id)));
        await tx.delete(nestRecords).where(eq(nestRecords.id, record.id));
        return { removed: true as const };
      });
      if ("error" in removed) {
        if (removed.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
        res.status(404).json({ error: "Item unavailable." }); return;
      }
      await removeStoredAttachments(storage, removedAttachments);
      res.sendStatus(204);
      return;
    }
    const removed = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor) return { error: "membership" as const };
      const [current] = await tx.select().from(nestRecords).where(and(
        eq(nestRecords.id, record.id), eq(nestRecords.householdId, member.householdId),
      )).for("update");
      if (!current || !canWriteRecord(actor, current)) return { error: "unavailable" as const };
      const [deleted] = await tx.delete(nestRecords).where(eq(nestRecords.id, record.id)).returning();
      if (deleted) await notifyRecordChange(tx, actor, deleted, "removed");
      return deleted ? { removed: true as const } : { error: "unavailable" as const };
    });
    if ("error" in removed) {
      if (removed.error === "membership") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
      res.status(404).json({ error: "Item unavailable." }); return;
    }
    res.sendStatus(204);
  });

  router.patch("/nest/members/:id", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member) { res.status(403).json({ error: "Join a household first." }); return; }
    const params = UpdateNestMemberParams.safeParse(req.params);
    const input = UpdateNestMemberBody.strict().safeParse(req.body);
    if (!params.success || !input.success || !Object.keys(input.data).length || (input.data.name !== undefined && !input.data.name.trim()) || (input.data.trackingLabel !== undefined && !input.data.trackingLabel.trim())) {
      res.status(400).json({ error: "Choose a valid name, avatar, or tracking label." }); return;
    }
    const selfCustomizationOnly = Object.keys(input.data).every((key) => key === "avatarId" || key === "trackingLabel");
    if (member.role !== "parent" && (params.data.id !== member.id || !selfCustomizationOnly)) {
      res.status(403).json({ error: "You can only customize your own avatar and school or work tracking. Other profile settings are parent-only." }); return;
    }
    const result = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor) return { error: "unavailable" as const };
      const actorMayManage = actor.role === "parent";
      if (!actorMayManage && (params.data.id !== actor.id || !Object.keys(input.data).every((key) => key === "avatarId" || key === "trackingLabel"))) {
        return { error: "forbidden" as const };
      }
      const [before] = await tx.select().from(nestMembers).where(and(
        eq(nestMembers.id, params.data.id), eq(nestMembers.householdId, member.householdId),
        isNull(nestMembers.removedAt),
      )).for("update");
      if (!before) return { error: "unavailable" as const };
      if (actorMayManage && before.role === "parent" && input.data.role !== undefined && input.data.role !== "parent") {
        const parents = await tx.select({ id: nestMembers.id }).from(nestMembers).where(and(
          eq(nestMembers.householdId, member.householdId), eq(nestMembers.role, "parent"),
          isNull(nestMembers.removedAt),
        ));
        if (parents.length <= 1) return { error: "last-parent" as const };
      }
      const [changed] = await tx.update(nestMembers).set({
        ...input.data, ...(input.data.name ? { name: input.data.name.trim() } : {}),
        ...(input.data.trackingLabel ? { trackingLabel: input.data.trackingLabel.trim() } : {}),
      }).where(eq(nestMembers.id, before.id)).returning();
      if (before.role !== changed.role) {
        await tx.update(nestInvitations).set({ usedAt: new Date() }).where(and(
          eq(nestInvitations.memberId, before.id), isNull(nestInvitations.usedAt),
        ));
      }
      if (before.name !== changed.name || before.avatarId !== changed.avatarId || before.role !== changed.role) {
        await notifyMembers(tx, actor, { kind: "members", recordId: changed.id, summary: `updated ${changed.name}'s household profile`, targetPath: "/" });
      }
      return { target: changed };
    });
    if ("error" in result) {
      if (result.error === "forbidden") { res.status(403).json({ error: "Only a parent can change another profile or household role." }); return; }
      if (result.error === "last-parent") { res.status(409).json({ error: "A household must keep at least one parent." }); return; }
      res.status(404).json({ error: "Profile unavailable." }); return;
    }
    res.json(UpdateNestMemberResponse.parse({ id: result.target.id }));
  });

  router.delete("/nest/members/:id", async (req, res): Promise<void> => {
    const member = await membership(req);
    if (!member || member.role !== "parent") { res.status(403).json({ error: "Only a parent can remove household members." }); return; }
    const params = UpdateNestMemberParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: "Choose a valid household profile." }); return; }
    let stagedAttachmentIds: string[] = [];
    const result = await db.transaction(async (tx) => {
      const actor = await lockActiveMember(tx, member, identity(req)!);
      if (!actor || actor.role !== "parent") return { error: "forbidden" as const };
      const [target] = await tx.select().from(nestMembers).where(and(
        eq(nestMembers.id, params.data.id), eq(nestMembers.householdId, member.householdId),
        isNull(nestMembers.removedAt),
      )).for("update");
      if (!target) return { error: "unavailable" as const };
      if (target.role === "parent") {
        const parents = await tx.select({ id: nestMembers.id }).from(nestMembers).where(and(
          eq(nestMembers.householdId, member.householdId), eq(nestMembers.role, "parent"),
          isNull(nestMembers.removedAt),
        ));
        if (parents.length <= 1) return { error: "last-parent" as const };
      }

      const removedAt = new Date();
      await tx.update(nestInvitations).set({ usedAt: removedAt }).where(and(
        eq(nestInvitations.memberId, target.id), isNull(nestInvitations.usedAt),
      ));
      await tx.delete(nestPasteDrafts).where(eq(nestPasteDrafts.ownerId, target.id));
      stagedAttachmentIds = (await tx.delete(nestAttachments).where(and(
        eq(nestAttachments.ownerId, target.id), isNull(nestAttachments.entryId),
      )).returning({ id: nestAttachments.id })).map((attachment) => attachment.id);
      await tx.delete(nestNotifications).where(and(
        eq(nestNotifications.householdId, member.householdId),
        or(eq(nestNotifications.recipientId, target.id), eq(nestNotifications.actorId, target.id)),
      ));
      await tx.update(nestMembers).set({ authUserId: null, removedAt }).where(eq(nestMembers.id, target.id));
      return { removed: true as const };
    });
    if ("error" in result) {
      if (result.error === "forbidden") { res.status(403).json({ error: "Only an active parent can remove household members." }); return; }
      if (result.error === "last-parent") { res.status(409).json({ error: "A household must keep at least one parent." }); return; }
      res.status(404).json({ error: "Profile unavailable." }); return;
    }
    await removeStoredAttachments(storage, stagedAttachmentIds);
    res.sendStatus(204);
  });
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ChorePaymentError) { res.status(400).json({ error: err.message }); return; }
    if (err instanceof JournalAttachmentError) { res.status(400).json({ error: err.message }); return; }
    next(err);
  });
  return router;
}

export default createNestRouter();
