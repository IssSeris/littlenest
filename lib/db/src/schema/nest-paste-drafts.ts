import { pgTable, uuid, text, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nestHouseholds, nestMembers } from "./nest";

// Empty slots retain a fresh revision so stale devices cannot resurrect a
// discarded/completed draft (including create/discard/create cycles).
export const nestPasteDrafts = pgTable("nest_paste_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => nestHouseholds.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => nestMembers.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  kind: text("kind", { enum: ["groceries", "chores"] }).notNull(),
  revision: uuid("revision").notNull().defaultRandom(),
  session: jsonb("session").$type<Record<string, unknown> | null>(),
}, (t) => [uniqueIndex("nest_paste_private_slot").on(t.householdId, t.ownerId, t.accountId, t.kind)]);

export const insertNestPasteDraftSchema = createInsertSchema(nestPasteDrafts).omit({ id: true });
export type NestPasteDraftRecord = typeof nestPasteDrafts.$inferSelect;