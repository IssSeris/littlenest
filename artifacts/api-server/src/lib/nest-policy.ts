import { z } from "zod/v4";
import type { NestMember, NestRecord } from "@workspace/db";
import { NestJournalMood } from "@workspace/api-zod";

const title = z.string().trim().min(1).max(300);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date");
const amount = z.number().finite().min(0).max(10000000);
const memberId = z.string().uuid();
export const recordSchemas = {
  chores: z.object({
    title, assignedTo: z.union([memberId, z.literal("household")]), cadence: z.enum(["Once", "Daily", "Weekdays", "Weekly"]), dueDate: day, done: z.boolean(),
    isPaid: z.boolean().optional(), payAmount: amount.multipleOf(0.01).optional(), completedOn: day.nullable().optional(),
  }).strict().refine((chore) => !chore.isPaid || (chore.payAmount ?? 0) >= 0.01, "Set a paid chore amount of at least $0.01."),
  allowance: z.object({ title, amount, date: day, status: z.enum(["earned", "paid"]) }).strict(),
  events: z.object({ title, date: day, time: z.string().max(80), memberId, category: z.string().trim().min(1).max(100) }).strict(),
  money: z.object({ title, amount, date: day, category: z.string().trim().min(1).max(100), kind: z.enum(["income", "expense"]) }).strict(),
  budgetPlans: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    incomeTarget: amount, savingsTarget: amount, note: z.string().trim().max(400),
    categories: z.array(z.object({
      category: z.string().trim().min(1).max(100), amount: z.number().finite().min(0.01).max(10000000),
      note: z.string().trim().max(160).optional(),
    }).strict()).max(100).refine((categories) => new Set(categories.map(({ category }) => category.toLocaleLowerCase().replace(/\s+/g, " "))).size === categories.length, "Budget categories must be unique"),
  }).strict(),
  schoolTasks: z.object({ title, memberId, dueDate: day, course: z.string().trim().min(1).max(200), done: z.boolean() }).strict(),
  goals: z.object({ title, memberId, progress: z.number().int().min(0).max(5), targetDate: day }).strict(),
  journal: z.object({ promptId: z.enum(["p1", "p2", "p3", "p4"]), body: z.string().trim().max(20000), attachmentIds: z.array(z.string().uuid()).max(10).refine((ids) => new Set(ids).size === ids.length, "Each attachment can only be added once").optional(), shared: z.boolean().optional(), mood: z.enum(Object.values(NestJournalMood)).nullable().optional() }).strict(),
  groceries: z.object({ title, quantity: z.string().trim().max(100), done: z.boolean() }).strict(),
  groceryFavorites: z.object({ title, quantity: z.string().trim().max(100) }).strict(),
  journalReplies: z.object({ entryId: z.string().uuid(), body: z.string().trim().min(1).max(5000) }).strict(),
};

export function canReadRecord(member: NestMember, record: NestRecord, entry?: NestRecord): boolean {
  if (member.householdId !== record.householdId) return false;
  if (record.kind === "journalReplies") return Boolean(entry && entry.kind === "journal" && entry.householdId === member.householdId && entry.shared && entry.id === record.data.entryId);
  if (record.kind === "money" || record.kind === "budgetPlans") return member.role === "parent";
  if (record.kind === "journal") return record.authorId === member.id || record.shared;
  return true;
}

export function canWriteRecord(member: NestMember, record: NestRecord): boolean {
  if (member.householdId !== record.householdId) return false;
  if (record.kind === "money" || record.kind === "budgetPlans") return member.role === "parent";
  if (record.kind === "journal" || record.kind === "journalReplies") return record.authorId === member.id;
  return true;
}