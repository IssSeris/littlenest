import { Router, raw, type Request } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { db, nestAttachments, nestRecords, nestMembers, nestHouseholds, type NestMember, type NestRecord } from "@workspace/db";
import { canReadRecord } from "../lib/nest-policy";
import { attachmentContentType, type JournalStorage } from "../lib/journal-storage";
import type { NestTransaction } from "../lib/nest-notifications";
import { logger } from "../lib/logger";

export class JournalAttachmentError extends Error {}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const attachmentMetadata = (a: typeof nestAttachments.$inferSelect) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType });
export async function removeStoredAttachments(storage: JournalStorage, ids: string[]) {
  await Promise.all(ids.map(async (id) => {
    try { await storage.remove(id); }
    catch (err) { logger.error({ err, attachmentId: id }, "Could not clean up private attachment"); }
  }));
}

// Caller holds the journal row lock. Bind only this author's staged files, or
// files already belonging to this entry. Never accept arbitrary object URLs.
export async function bindJournalAttachments(tx: NestTransaction, member: NestMember, entry: NestRecord, data: Record<string, unknown>): Promise<string[]> {
  const ids = (data.attachmentIds ?? entry.data.attachmentIds ?? []) as string[];
  if (!String(data.body ?? "").trim() && !ids.length) throw new JournalAttachmentError("Write a few words or attach a file.");
  const files = ids.length ? await tx.select().from(nestAttachments).where(inArray(nestAttachments.id, ids)).for("update") : [];
  if (files.length !== ids.length || files.some((a) => a.ownerId !== member.id || a.householdId !== member.householdId || (a.entryId !== null && a.entryId !== entry.id))) {
    throw new JournalAttachmentError("An attachment is unavailable. Please attach it again.");
  }
  if (ids.length) await tx.update(nestAttachments).set({ entryId: entry.id }).where(inArray(nestAttachments.id, ids));
  const removed = await tx.delete(nestAttachments).where(and(eq(nestAttachments.entryId, entry.id), ids.length ? notInArray(nestAttachments.id, ids) : undefined)).returning({ id: nestAttachments.id });
  data.attachmentIds = ids;
  return removed.map((a) => a.id);
}

export function createAttachmentRouter(membership: (req: Request) => Promise<NestMember | undefined>, storage: JournalStorage) {
  const router = Router();
  router.post("/nest/attachments", async (req, res, next) => {
    const member = await membership(req);
    if (!member) { res.status(403).json({ error: "Join a household first." }); return; }
    raw({ type: "application/octet-stream", limit: "10mb" })(req, res, async (err) => {
      if (err) { res.status(413).json({ error: "Each attachment must be 10 MB or smaller." }); return; }
      try {
        const name = typeof req.query.name === "string" ? req.query.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim() : "";
        if (!name || name.length > 200 || !Buffer.isBuffer(req.body) || !req.body.length) { res.status(400).json({ error: "Choose a named, nonempty file." }); return; }
        const contentType = attachmentContentType(req.body, name);
        if (!contentType) { res.status(415).json({ error: "Choose a PNG, JPG, GIF, WebP, PDF, text, Office document, or ZIP file." }); return; }
        const id = randomUUID();
        const result = await db.transaction(async (tx) => {
          // Match the household → member lock order used by membership removal.
          await tx.select({ id: nestHouseholds.id }).from(nestHouseholds).where(eq(nestHouseholds.id, member.householdId)).for("update");
          const [owner] = await tx.select().from(nestMembers).where(and(
            eq(nestMembers.id, member.id), eq(nestMembers.householdId, member.householdId),
            eq(nestMembers.authUserId, member.authUserId!), isNull(nestMembers.removedAt),
          )).for("update");
          if (!owner) return { error: "unavailable" as const };
          // Serialize per-owner staging limits, including simultaneous paste/picker uploads.
          const expired = await tx.delete(nestAttachments).where(and(eq(nestAttachments.ownerId, owner.id), isNull(nestAttachments.entryId), lt(nestAttachments.createdAt, new Date(Date.now() - 86400000)))).returning({ id: nestAttachments.id });
          await removeStoredAttachments(storage, expired.map((a) => a.id));
          const pending = await tx.select({ id: nestAttachments.id }).from(nestAttachments).where(and(eq(nestAttachments.ownerId, owner.id), isNull(nestAttachments.entryId))).limit(20);
          if (pending.length >= 20) return { error: "limit" as const };
          await storage.put(id, req.body, contentType);
          const [file] = await tx.insert(nestAttachments).values({ id, householdId: owner.householdId, ownerId: owner.id, name, contentType, size: req.body.length }).returning();
          return { file };
        });
        if ("error" in result) {
          if (result.error === "unavailable") { res.status(403).json({ error: "Household membership is no longer available." }); return; }
          res.status(429).json({ error: "You have too many unsaved attachments. Save or remove files from your open draft before uploading more." }); return;
        }
        res.status(201).json(attachmentMetadata(result.file));
      } catch (error) { next(error); }
    });
  });
  router.get(["/nest/attachments/:id", "/nest/attachments/:id/download"], async (req, res, next) => {
    const member = await membership(req);
    if (!member) { res.status(404).json({ error: "Attachment unavailable." }); return; }
    if (!uuidPattern.test(String(req.params.id))) { res.status(404).json({ error: "Attachment unavailable." }); return; }
    const [attachment] = await db.select().from(nestAttachments).where(and(eq(nestAttachments.id, String(req.params.id)), eq(nestAttachments.householdId, member.householdId)));
    if (!attachment) { res.status(404).json({ error: "Attachment unavailable." }); return; }
    if (attachment.entryId) {
      const [entry] = await db.select().from(nestRecords).where(eq(nestRecords.id, attachment.entryId));
      if (!entry || entry.kind !== "journal" || !canReadRecord(member, entry)) { res.status(404).json({ error: "Attachment unavailable." }); return; }
    } else if (attachment.ownerId !== member.id) { res.status(404).json({ error: "Attachment unavailable." }); return; }
    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader("Content-Length", attachment.size);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    const mode = attachment.contentType.startsWith("image/") && req.query.download !== "1" && !req.path.endsWith("/download") ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${mode}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`);
    try {
      const stream = storage.read(attachment.id);
      stream.on("error", (error) => { if (res.headersSent) res.destroy(); else { res.removeHeader("Content-Length"); next(error); } });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (err) { res.removeHeader("Content-Length"); next(err); }
  });
  router.delete("/nest/attachments/:id", async (req, res) => {
    const member = await membership(req);
    if (!member || !uuidPattern.test(String(req.params.id))) { res.status(404).json({ error: "Attachment unavailable." }); return; }
    const removed = await db.transaction(async (tx) => {
      const [a] = await tx.select().from(nestAttachments).where(and(eq(nestAttachments.id, String(req.params.id)), eq(nestAttachments.ownerId, member.id), eq(nestAttachments.householdId, member.householdId))).for("update");
      if (!a || a.entryId) return false;
      await tx.delete(nestAttachments).where(eq(nestAttachments.id, a.id));
      return true;
    });
    // Idempotent draft cleanup: saved files are untouched, and other owners'
    // IDs are indistinguishable from nonexistent IDs.
    if (removed) await removeStoredAttachments(storage, [String(req.params.id)]);
    res.sendStatus(204);
  });
  return router;
}