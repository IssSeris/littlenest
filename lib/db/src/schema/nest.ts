import { isNull, sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, boolean, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const nestHouseholds = pgTable("nest_households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nestMembers = pgTable("nest_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => nestHouseholds.id),
  authUserId: text("auth_user_id"),
  role: text("role", { enum: ["parent", "child", "householdMember"] }).notNull(),
  name: text("name").notNull(),
  avatarId: text("avatar_id").notNull(),
  trackingLabel: text("tracking_label").notNull().default("School & work"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("nest_member_auth_unique").on(t.authUserId),
  index("nest_member_household_active_idx").on(t.householdId, t.removedAt),
  check("nest_member_role_check", sql`${t.role} in ('parent', 'child', 'householdMember')`),
]);

export const nestInvitations = pgTable("nest_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => nestHouseholds.id),
  memberId: uuid("member_id").references(() => nestMembers.id),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("nest_invitation_member_active_unique").on(t.memberId).where(isNull(t.usedAt)),
]);

export const nestRecords = pgTable("nest_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => nestHouseholds.id),
  kind: text("kind", { enum: ["chores", "allowance", "events", "money", "budgetPlans", "schoolTasks", "goals", "journal", "groceries", "groceryFavorites", "journalReplies"] }).notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  authorId: uuid("author_id").notNull().references(() => nestMembers.id),
  shared: boolean("shared").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertNestHouseholdSchema = createInsertSchema(nestHouseholds).omit({ id: true, createdAt: true });
export const nestAttachments = pgTable("nest_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => nestHouseholds.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => nestMembers.id, { onDelete: "cascade" }),
  entryId: uuid("entry_id").references(() => nestRecords.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  size: jsonb("size").$type<number>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("nest_attachment_entry").on(t.entryId), index("nest_attachment_owner").on(t.ownerId)]);
export const nestNotifications = pgTable("nest_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => nestHouseholds.id, { onDelete: "cascade" }),
  recipientId: uuid("recipient_id").notNull().references(() => nestMembers.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => nestMembers.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  recordId: uuid("record_id").notNull(),
  entryId: uuid("entry_id"),
  summary: text("summary").notNull(),
  targetPath: text("target_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [index("nest_notification_recipient_time").on(t.recipientId, t.createdAt)]);
export const insertNestMemberSchema = createInsertSchema(nestMembers).omit({ id: true });
export const insertNestInvitationSchema = createInsertSchema(nestInvitations).omit({ id: true });
export const insertNestRecordSchema = createInsertSchema(nestRecords).omit({ id: true, createdAt: true });
export type NestMember = typeof nestMembers.$inferSelect;
export type NestRecord = typeof nestRecords.$inferSelect;