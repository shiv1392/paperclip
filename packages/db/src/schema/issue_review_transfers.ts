import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Audited move of an outstanding child review obligation to its top-level
 * delivery. The source issue keeps its stage and decision history; this row is
 * the durable hold that stops the source from dispatching its reviewer, and the
 * destination stage it names cannot be approved until `receipts` satisfies
 * `obligation.requiredReceipts`.
 */
export const issueReviewTransfers = pgTable(
  "issue_review_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceStageId: uuid("source_stage_id").notNull(),
    destinationIssueId: uuid("destination_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    destinationStageId: uuid("destination_stage_id").notNull(),
    status: text("status").$type<"held" | "satisfied">().notNull().default("held"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    reason: text("reason").notNull(),
    obligation: jsonb("obligation").$type<Record<string, unknown>>().notNull(),
    removedBlockerIssueId: uuid("removed_blocker_issue_id"),
    removedBlockedIssueId: uuid("removed_blocked_issue_id"),
    receipts: jsonb("receipts").$type<Record<string, unknown>[]>().notNull().default([]),
    receiptRevision: text("receipt_revision"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceStageUq: uniqueIndex("issue_review_transfers_source_stage_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.sourceStageId,
    ),
    idempotencyUq: uniqueIndex("issue_review_transfers_idempotency_uq").on(table.companyId, table.idempotencyKey),
    destinationStageUq: uniqueIndex("issue_review_transfers_destination_stage_uq").on(
      table.companyId,
      table.destinationIssueId,
      table.destinationStageId,
    ),
    companySourceIdx: index("issue_review_transfers_company_source_idx").on(table.companyId, table.sourceIssueId),
    companyDestinationIdx: index("issue_review_transfers_company_destination_idx").on(
      table.companyId,
      table.destinationIssueId,
    ),
  }),
);
