import { and, eq } from "drizzle-orm";
import { nestMembers, nestRecords, type NestMember, type NestRecord } from "@workspace/db";
import { notifyRecordChange, type NestTransaction } from "./nest-notifications";

export class ChorePaymentError extends Error {}
const awardsFor = (data: Record<string, unknown>): Record<string, string> =>
  data._allowanceAwards && typeof data._allowanceAwards === "object" && !Array.isArray(data._allowanceAwards)
    ? { ...data._allowanceAwards as Record<string, string> } : {};

export const choreAllowanceRecorded = (data: Record<string, unknown>) => Boolean(awardsFor(data)[String(data.dueDate)]);

/** The chore lock and this ledger write must share a transaction. Never trust client award history. */
export async function prepareChoreWrite(tx: NestTransaction, actor: NestMember, input: Record<string, unknown>, previous?: NestRecord) {
  const isPaid = typeof input.isPaid === "boolean" ? input.isPaid : Boolean(previous?.data.isPaid);
  const payAmount = isPaid ? Number(input.payAmount ?? previous?.data.payAmount ?? 0) : 0;
  if (isPaid && payAmount < 0.01) throw new ChorePaymentError("Set a paid chore amount of at least $0.01.");
  const awards = awardsFor(previous?.data ?? {});
  const completedOn = input.done ? input.completedOn ?? previous?.data.completedOn ?? new Date().toISOString().slice(0, 10) : null;
  const data = { ...input, isPaid, payAmount, completedOn, _allowanceAwards: awards };
  if (!input.done || previous?.data.done || !isPaid || awards[String(input.dueDate)]) return { data };

  const [assignee] = input.assignedTo === "household" ? [] : await tx.select({ name: nestMembers.name }).from(nestMembers).where(and(
    eq(nestMembers.id, String(input.assignedTo)), eq(nestMembers.householdId, actor.householdId),
  ));
  const assigneeLabel = assignee?.name ?? "Household";
  const allowanceData = {
    title: `${String(input.title).slice(0, 297 - assigneeLabel.length)} · ${assigneeLabel}`,
    amount: payAmount, date: String(completedOn), status: "earned" as const,
  };
  const [entry] = await tx.insert(nestRecords).values({
    householdId: actor.householdId, authorId: actor.id, kind: "allowance", data: allowanceData, shared: false,
  }).returning();
  awards[String(input.dueDate)] = entry.id;
  await notifyRecordChange(tx, actor, entry, "added");
  return { data, allowanceEntry: { ...allowanceData, id: entry.id } };
}