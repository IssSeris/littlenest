import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db, nestMembers, nestNotifications, type NestMember, type NestRecord } from "@workspace/db";

export type NestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const sections: Record<NestRecord["kind"], string> = {
  chores: "/chores", allowance: "/chores", events: "/calendar", money: "/money", budgetPlans: "/money",
  schoolTasks: "/school", goals: "/school", journal: "/journal", journalReplies: "/journal",
  groceries: "/groceries", groceryFavorites: "/groceries",
};
const names: Record<NestRecord["kind"], string> = {
  chores: "a chore", allowance: "an allowance note", events: "a calendar event",
  money: "a money note", budgetPlans: "a budget plan", schoolTasks: "a school task", goals: "a goal",
  journal: "a journal entry", journalReplies: "a reply", groceries: "a grocery item",
  groceryFavorites: "a grocery favorite",
};

export async function notifyMembers(tx: NestTransaction, actor: NestMember, event: {
  kind: string; recordId: string; entryId?: string; summary: string; targetPath: string;
}) {
  const recipients = await tx.select({ id: nestMembers.id }).from(nestMembers).where(and(
    eq(nestMembers.householdId, actor.householdId), ne(nestMembers.id, actor.id),
    isNotNull(nestMembers.authUserId), isNull(nestMembers.removedAt),
  ));
  if (recipients.length) await tx.insert(nestNotifications).values(recipients.map(({ id }) => ({
    ...event, householdId: actor.householdId, actorId: actor.id, recipientId: id,
  })));
}

// Events are written in the same transaction as the change, never inferred from polling.
// Journal events contain no body/mood preview; snapshot access rechecks the live entry.
export async function notifyRecordChange(
  tx: NestTransaction, actor: NestMember, record: NestRecord,
  action: "added" | "updated" | "removed", before?: NestRecord,
) {
  if (record.kind === "money" || record.kind === "budgetPlans") return;
  const eventData = (r: NestRecord) => r.kind === "journal" ? { ...r.data, attachmentIds: r.data.attachmentIds ?? [] } : r.data;
  if (action === "updated" && before && isDeepStrictEqual(eventData(record), eventData(before)) && record.shared === before.shared) return;
  if (record.kind === "journal" && (!record.shared || action === "removed")) return;
  let summary = `${action} ${names[record.kind]}`;
  let entryId: string | undefined;
  if (record.kind === "journal") {
    entryId = record.id;
    summary = before && !before.shared ? "shared a journal entry" : "updated a shared journal entry";
  } else if (record.kind === "journalReplies") {
    entryId = String(record.data.entryId);
    summary = action === "added" ? "replied to a shared journal entry" : `${action === "updated" ? "edited" : "removed"} a reply to a shared journal entry`;
  } else {
    if (action === "updated" && before && record.data.done !== before.data.done) {
      summary = `${record.data.done ? "completed" : "reopened"} ${names[record.kind]}`;
    }
    if (record.data.title) summary += `: ${String(record.data.title)}`;
  }
  await notifyMembers(tx, actor, {
    kind: record.kind, recordId: record.id, entryId, summary,
    targetPath: entryId ? `/journal?entry=${entryId}` : sections[record.kind],
  });
}