import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  approvals,
  environmentLeases,
  heartbeatRuns,
  issueApprovals,
  issueExecutionDecisions,
  issueRelations,
  issueReviewTransfers,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  AttachIssueReviewTransferReceipts,
  IssueExecutionPolicy,
  IssueExecutionStage,
  RequestIssueReviewTransfer,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

export type IssueReviewTransferRow = typeof issueReviewTransfers.$inferSelect;

export type ReviewTransferActor = {
  userId: string | null;
  agentId: string | null;
  runId: string | null;
};

export type RequestReviewTransferInput = RequestIssueReviewTransfer & {
  companyId: string;
  sourceIssueId: string;
};

export type AttachReviewTransferReceiptsInput = AttachIssueReviewTransferReceipts & {
  companyId: string;
  transferId: string;
};

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const OUTSTANDING_SOURCE_STATES = new Set(["pending", "changes_requested", "idle", "none"]);

function fingerprint(input: RequestReviewTransferInput) {
  const { idempotencyKey: _key, removeBlocksIssueId, ...rest } = input;
  // Omitted and null mean the same request, so a replay must match either.
  return createHash("sha256").update(JSON.stringify({ ...rest, removeBlocksIssueId: removeBlocksIssueId ?? null })).digest("hex");
}

function policyStages(policy: IssueExecutionPolicy | null) {
  return policy?.stages ?? [];
}

async function lockIssues(tx: Tx, companyId: string, ids: string[]) {
  // Lock in a stable order so two transfers touching the same pair cannot deadlock.
  const ordered = [...new Set(ids)].sort();
  const rows: Array<typeof issues.$inferSelect> = [];
  for (const id of ordered) {
    const [row] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, id), eq(issues.companyId, companyId)))
      .for("update");
    if (row) rows.push(row);
  }
  return new Map(rows.map((row) => [row.id, row]));
}

async function isAncestor(tx: Tx, companyId: string, ancestorId: string, issueId: string) {
  let cursor: string | null = issueId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const [row]: Array<{ parentId: string | null }> = await tx
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(and(eq(issues.id, cursor), eq(issues.companyId, companyId)));
    cursor = row?.parentId ?? null;
    if (cursor === ancestorId) return true;
  }
  return false;
}

async function assertNoLiveExecution(tx: Tx, issue: typeof issues.$inferSelect, role: "source" | "destination") {
  if (issue.executionRunId || issue.checkoutRunId) {
    throw conflict(`The ${role} task has an active execution. Wait for it to finish before transferring review.`, {
      code: "review_transfer_execution_active",
      issueId: issue.id,
    });
  }
  const [run] = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
      or(
        eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      ),
    ))
    .limit(1);
  if (run) {
    throw conflict(`The ${role} task has a live run. Wait for it to finish before transferring review.`, {
      code: "review_transfer_execution_active",
      issueId: issue.id,
      runId: run.id,
    });
  }
  const [lease] = await tx
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(and(
      eq(environmentLeases.companyId, issue.companyId),
      eq(environmentLeases.issueId, issue.id),
      eq(environmentLeases.status, "active"),
    ))
    .limit(1);
  if (lease) {
    throw conflict(`The ${role} task holds an active environment lease.`, {
      code: "review_transfer_lease_active",
      issueId: issue.id,
      leaseId: lease.id,
    });
  }
}

async function assertNoUnresolvedHumanControls(tx: Tx, issue: typeof issues.$inferSelect, role: "source" | "destination") {
  const [approval] = await tx
    .select({ id: approvals.id })
    .from(issueApprovals)
    .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
    .where(and(
      eq(issueApprovals.companyId, issue.companyId),
      eq(issueApprovals.issueId, issue.id),
      inArray(approvals.status, ["pending", "revision_requested"]),
    ))
    .limit(1);
  const [interaction] = await tx
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.effectiveResolverPolicy, "human_only"),
    ))
    .limit(1);
  if (approval || interaction) {
    throw conflict(`The ${role} task has an unresolved human approval or question.`, {
      code: "review_transfer_human_control_pending",
      issueId: issue.id,
      approvalId: approval?.id ?? null,
      interactionId: interaction?.id ?? null,
    });
  }
}

function assertUnchanged(issue: typeof issues.$inferSelect, expected: string, role: "source" | "destination") {
  if (issue.updatedAt.toISOString() !== new Date(expected).toISOString()) {
    throw conflict(`The ${role} task changed since it was read. Read it again and resend the transfer.`, {
      code: "review_transfer_stale",
      issueId: issue.id,
      expectedUpdatedAt: expected,
      actualUpdatedAt: issue.updatedAt.toISOString(),
    });
  }
}

function copyStageForDestination(stage: IssueExecutionStage): IssueExecutionStage {
  return {
    id: randomUUID(),
    type: stage.type,
    approvalsNeeded: stage.approvalsNeeded,
    participants: stage.participants.map((participant) => ({ ...participant, id: randomUUID() })),
  };
}

function receiptProblems(row: IssueReviewTransferRow, input: AttachReviewTransferReceiptsInput) {
  const problems: string[] = [];
  if (input.source.issueId !== row.sourceIssueId || input.source.stageId !== row.sourceStageId) {
    problems.push("source issue or stage does not match the transfer");
  }
  const pins = row.obligation.requiredReceipts as RequestReviewTransferInput["requiredReceipts"];
  if (input.destination.originalBase !== pins.originalBase) problems.push("original base does not match the pinned base");
  if (input.source.commit !== pins.sourceCommit) problems.push("source commit does not match the pinned commit");
  if (input.source.tree !== pins.sourceTree) problems.push("source tree does not match the pinned tree");
  for (const childIssueId of pins.childIssueIds) {
    const child = input.childResults.find((result) => result.issueId === childIssueId);
    if (!child) problems.push(`missing required child result: ${childIssueId}`);
    else if (!child.includedInFinalHead) problems.push(`child result is not in the final head: ${childIssueId}`);
  }
  const sourceResult = input.childResults.find((result) => result.issueId === row.sourceIssueId);
  if (sourceResult && sourceResult.commit !== pins.sourceCommit) {
    problems.push("the source child result commit does not match the pinned commit");
  }
  for (const command of pins.commands) {
    const result = input.commands.find((candidate) => candidate.command === command);
    if (!result) problems.push(`missing required command: ${command}`);
    else if (result.exitCode !== 0) problems.push(`required command failed: ${command}`);
    else if (result.testedTree !== input.destination.finalTree) problems.push(`required command ran on another tree: ${command}`);
  }
  return problems;
}

/** The latest receipt is in force; earlier versions stay as history. */
function currentReceipt(row: IssueReviewTransferRow) {
  return row.receipts.length > 0 ? row.receipts[row.receipts.length - 1]! : null;
}

export function issueReviewTransferService(db: Db) {
  async function findReplay(tx: DbOrTx, input: RequestReviewTransferInput) {
    const [existing] = await tx
      .select()
      .from(issueReviewTransfers)
      .where(and(
        eq(issueReviewTransfers.companyId, input.companyId),
        eq(issueReviewTransfers.idempotencyKey, input.idempotencyKey),
      ));
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint(input)) {
      throw conflict("This idempotency key was already used for a different transfer.", {
        code: "review_transfer_idempotency_mismatch",
        transferId: existing.id,
      });
    }
    return existing;
  }

  async function transfer(input: RequestReviewTransferInput, actor: ReviewTransferActor) {
    const replay = await findReplay(db, input);
    if (replay) return { transfer: replay, replayed: true };

    return db.transaction(async (tx) => {
      const locked = await lockIssues(tx, input.companyId, [input.sourceIssueId, input.destinationIssueId]);
      // Re-check under the lock: a concurrent request with the same key may have committed first.
      const lockedReplay = await findReplay(tx, input);
      if (lockedReplay) return { transfer: lockedReplay, replayed: true };

      const source = locked.get(input.sourceIssueId);
      const destination = locked.get(input.destinationIssueId);
      if (!source) throw notFound("Source issue not found");
      if (!destination) throw notFound("Destination issue not found");
      if (source.id === destination.id) {
        throw unprocessable("A review cannot be transferred to its own task.", { code: "review_transfer_invalid_destination" });
      }
      if (destination.parentId !== null || !(await isAncestor(tx, input.companyId, destination.id, source.id))) {
        throw unprocessable("The destination must be the top-level delivery that contains the source task.", {
          code: "review_transfer_invalid_destination",
        });
      }
      if (!input.requiredReceipts.childIssueIds.includes(source.id)) {
        throw unprocessable("The required child results must include the source task.", {
          code: "review_transfer_children_invalid",
        });
      }
      for (const childIssueId of input.requiredReceipts.childIssueIds) {
        if (childIssueId !== source.id && !(await isAncestor(tx, input.companyId, destination.id, childIssueId))) {
          throw unprocessable("Each required child must be part of the destination delivery.", {
            code: "review_transfer_children_invalid",
            childIssueId,
          });
        }
      }
      assertUnchanged(source, input.expectedSourceUpdatedAt, "source");
      assertUnchanged(destination, input.expectedDestinationUpdatedAt, "destination");
      if (source.status === "done" || source.status === "cancelled") {
        throw unprocessable("A closed task has no outstanding review to transfer.", { code: "review_transfer_source_closed" });
      }
      if (destination.status === "done" || destination.status === "cancelled") {
        throw unprocessable("The destination delivery is closed.", { code: "review_transfer_invalid_destination" });
      }

      const sourcePolicy = normalizeIssueExecutionPolicy(source.executionPolicy ?? null);
      const sourceStage = policyStages(sourcePolicy).find((stage) => stage.id === input.sourceStageId);
      if (!sourceStage) {
        throw unprocessable("The source stage is not part of the source task's review policy.", {
          code: "review_transfer_stage_not_found",
        });
      }
      const sourceState = parseIssueExecutionState(source.executionState);
      const stateStatus = sourceState?.status ?? "none";
      const stageIsCurrent = sourceState?.currentStageId === sourceStage.id;
      const stageCompleted = sourceState?.completedStageIds.includes(sourceStage.id) ?? false;
      if (stageCompleted || !OUTSTANDING_SOURCE_STATES.has(stateStatus)
        || ((stateStatus === "pending" || stateStatus === "changes_requested") && !stageIsCurrent)) {
        throw unprocessable("The source stage has no outstanding review obligation.", {
          code: "review_transfer_stage_not_outstanding",
          stateStatus,
        });
      }

      const destinationPolicy = normalizeIssueExecutionPolicy(destination.executionPolicy ?? null);
      if (!destinationPolicy || destinationPolicy.stages.length === 0) {
        throw unprocessable("The destination has no native review gate to hold this obligation.", {
          code: "review_transfer_destination_gate_missing",
        });
      }
      const destinationState = parseIssueExecutionState(destination.executionState);
      if (destinationState && destinationState.status !== "idle") {
        throw conflict("The destination review has already started. Transfer obligations before it starts.", {
          code: "review_transfer_destination_review_active",
        });
      }

      await assertNoLiveExecution(tx, source, "source");
      await assertNoLiveExecution(tx, destination, "destination");
      await assertNoUnresolvedHumanControls(tx, source, "source");
      await assertNoUnresolvedHumanControls(tx, destination, "destination");

      const [claimed] = await tx
        .select({ id: issueReviewTransfers.id })
        .from(issueReviewTransfers)
        .where(and(
          eq(issueReviewTransfers.companyId, input.companyId),
          eq(issueReviewTransfers.sourceIssueId, source.id),
          eq(issueReviewTransfers.sourceStageId, sourceStage.id),
        ));
      if (claimed) {
        throw conflict("This review stage was already transferred.", {
          code: "review_transfer_already_transferred",
          transferId: claimed.id,
        });
      }

      let removedEdge: { blockerId: string; blockedId: string } | null = null;
      if (input.removeBlocksIssueId) {
        const deleted = await tx
          .delete(issueRelations)
          .where(and(
            eq(issueRelations.companyId, input.companyId),
            eq(issueRelations.issueId, source.id),
            eq(issueRelations.relatedIssueId, input.removeBlocksIssueId),
            eq(issueRelations.type, "blocks"),
          ))
          .returning({ id: issueRelations.id });
        if (deleted.length !== 1) {
          throw unprocessable("The named scheduling edge does not exist from the source task.", {
            code: "review_transfer_edge_not_found",
          });
        }
        removedEdge = { blockerId: source.id, blockedId: input.removeBlocksIssueId };
      }

      const decisions = await tx
        .select({ id: issueExecutionDecisions.id, outcome: issueExecutionDecisions.outcome })
        .from(issueExecutionDecisions)
        .where(and(
          eq(issueExecutionDecisions.companyId, input.companyId),
          eq(issueExecutionDecisions.issueId, source.id),
          eq(issueExecutionDecisions.stageId, sourceStage.id),
        ));

      const mappedStage = copyStageForDestination(sourceStage);
      // Transferred obligations precede the existing whole-delivery gate so
      // every one is decided before the delivery itself is reviewed.
      const nextDestinationPolicy: IssueExecutionPolicy = {
        ...destinationPolicy,
        stages: [mappedStage, ...destinationPolicy.stages],
      };
      const now = new Date();
      await tx
        .update(issues)
        .set({ executionPolicy: nextDestinationPolicy as unknown as Record<string, unknown>, updatedAt: now })
        .where(and(eq(issues.id, destination.id), eq(issues.companyId, input.companyId)));

      const [row] = await tx
        .insert(issueReviewTransfers)
        .values({
          companyId: input.companyId,
          sourceIssueId: source.id,
          sourceStageId: sourceStage.id,
          destinationIssueId: destination.id,
          destinationStageId: mappedStage.id,
          status: "held",
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint(input),
          reason: input.reason,
          obligation: {
            stageType: sourceStage.type,
            participants: sourceStage.participants,
            approvalsNeeded: sourceStage.approvalsNeeded,
            commentRequired: sourcePolicy?.commentRequired ?? true,
            returnAssignee: sourceState?.returnAssignee ?? null,
            currentParticipant: sourceState?.currentParticipant ?? null,
            sourceStateStatus: stateStatus,
            changesRequestedCount: sourceState?.changesRequestedCount ?? 0,
            decisionIds: decisions.map((decision) => decision.id),
            decisionOutcomes: decisions.map((decision) => decision.outcome),
            sourceUpdatedAt: source.updatedAt.toISOString(),
            destinationUpdatedAt: destination.updatedAt.toISOString(),
            requiredReceipts: input.requiredReceipts,
          },
          removedBlockerIssueId: removedEdge?.blockerId ?? null,
          removedBlockedIssueId: removedEdge?.blockedId ?? null,
          actorAgentId: actor.agentId,
          actorUserId: actor.userId,
          createdByRunId: actor.runId,
        })
        .returning();

      const details = {
        transferId: row!.id,
        sourceIssueId: source.id,
        sourceStageId: sourceStage.id,
        destinationIssueId: destination.id,
        destinationStageId: mappedStage.id,
        removedBlocksIssueId: removedEdge?.blockedId ?? null,
        reason: input.reason,
      };
      for (const entityId of [source.id, destination.id, ...(removedEdge ? [removedEdge.blockedId] : [])]) {
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: actor.agentId ? "agent" : "user",
          actorId: actor.agentId ?? actor.userId ?? "board",
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.review_transferred",
          entityType: "issue",
          entityId,
          details,
        });
      }
      return { transfer: row!, replayed: false };
    });
  }

  async function readTransfers(companyId: string, issueId: string) {
    const rows = await db
      .select()
      .from(issueReviewTransfers)
      .where(and(
        eq(issueReviewTransfers.companyId, companyId),
        or(eq(issueReviewTransfers.sourceIssueId, issueId), eq(issueReviewTransfers.destinationIssueId, issueId)),
      ));
    return {
      outgoing: rows.filter((row) => row.sourceIssueId === issueId),
      incoming: rows.filter((row) => row.destinationIssueId === issueId),
    };
  }

  async function attachReceipts(input: AttachReviewTransferReceiptsInput, actor: ReviewTransferActor) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(issueReviewTransfers)
        .where(and(eq(issueReviewTransfers.id, input.transferId), eq(issueReviewTransfers.companyId, input.companyId)))
        .for("update");
      if (!row) throw notFound("Review transfer not found");
      const { idempotencyKey, expectedReceiptRevision: _expected, companyId: _company, transferId: _transfer, ...evidence } = input;
      const evidenceFingerprint = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
      const prior = row.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== evidenceFingerprint) {
          throw conflict("This idempotency key was already used for different receipts.", {
            code: "review_transfer_idempotency_mismatch",
          });
        }
        return { transfer: row, replayed: true };
      }
      if (row.receiptRevision !== input.expectedReceiptRevision) {
        throw conflict("The transfer receipts changed since they were read. Read them again and resend.", {
          code: "review_transfer_receipts_stale",
          receiptRevision: row.receiptRevision,
        });
      }
      const problems = receiptProblems(row, input);
      if (problems.length > 0) {
        throw unprocessable("The receipts do not satisfy this transfer.", {
          code: "review_transfer_receipts_invalid",
          problems,
        });
      }
      const revision = randomUUID();
      const receipt = {
        revision,
        idempotencyKey,
        fingerprint: evidenceFingerprint,
        attachedAt: new Date().toISOString(),
        actorAgentId: actor.agentId,
        actorUserId: actor.userId,
        runId: actor.runId,
        ...evidence,
      };
      const [updated] = await tx
        .update(issueReviewTransfers)
        .set({ receipts: [...row.receipts, receipt], receiptRevision: revision, updatedAt: new Date() })
        .where(eq(issueReviewTransfers.id, row.id))
        .returning();
      for (const entityId of [row.sourceIssueId, row.destinationIssueId]) {
        await logActivity(tx as unknown as Db, {
          companyId: row.companyId,
          actorType: actor.agentId ? "agent" : "user",
          actorId: actor.agentId ?? actor.userId ?? "board",
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.review_transfer_receipts_attached",
          entityType: "issue",
          entityId,
          details: { transferId: row.id, receiptRevision: revision, finalHead: input.destination.finalHead, finalTree: input.destination.finalTree },
        });
      }
      return { transfer: updated!, replayed: false };
    });
  }

  async function getTransfer(companyId: string, transferId: string) {
    const [row] = await db
      .select()
      .from(issueReviewTransfers)
      .where(and(eq(issueReviewTransfers.id, transferId), eq(issueReviewTransfers.companyId, companyId)));
    return row ?? null;
  }

  async function sourceIssueIdFor(transferId: string) {
    const [row] = await db
      .select({ sourceIssueId: issueReviewTransfers.sourceIssueId })
      .from(issueReviewTransfers)
      .where(eq(issueReviewTransfers.id, transferId));
    return row?.sourceIssueId ?? null;
  }

  return { transfer, readTransfers, attachReceipts, getTransfer, sourceIssueIdFor };
}

async function transfersTouching(tx: DbOrTx, companyId: string, issueId: string) {
  return tx
    .select()
    .from(issueReviewTransfers)
    .where(and(
      eq(issueReviewTransfers.companyId, companyId),
      or(eq(issueReviewTransfers.sourceIssueId, issueId), eq(issueReviewTransfers.destinationIssueId, issueId)),
    ));
}

/**
 * Called inside the transaction that records a native review decision. A held
 * source stage may not be decided at all; a transferred destination stage, and
 * the delivery stages after it, may not be approved until the transfer has a
 * complete receipt set. An approval of the mapped stage marks the transfer
 * satisfied.
 */
export async function assertReviewEligible(
  tx: DbOrTx,
  input: { companyId: string; issueId: string; stageId: string; outcome: string },
) {
  const rows = await transfersTouching(tx, input.companyId, input.issueId);
  const heldSource = rows.find((row) => row.sourceIssueId === input.issueId && row.sourceStageId === input.stageId);
  if (heldSource) {
    throw conflict("This review was transferred to the delivery. Decide it on the delivery instead.", {
      code: "review_transfer_source_held",
      transferId: heldSource.id,
      destinationIssueId: heldSource.destinationIssueId,
    });
  }
  if (input.outcome !== "approved") return;
  const unproven = rows.find((row) => row.destinationIssueId === input.issueId && currentReceipt(row) === null);
  if (unproven) {
    throw conflict("A transferred review cannot be approved until its receipts are attached.", {
      code: "review_transfer_receipts_missing",
      transferId: unproven.id,
    });
  }
  // Approving the mapped stage settles the moved obligation in the same
  // transaction as the decision. The source may then close; its reviewer
  // stays undispatched there, because the review was decided elsewhere.
  const decided = rows.find((row) => row.destinationIssueId === input.issueId && row.destinationStageId === input.stageId);
  if (decided && decided.status === "held") {
    await tx
      .update(issueReviewTransfers)
      .set({ status: "satisfied", updatedAt: new Date() })
      .where(eq(issueReviewTransfers.id, decided.id));
  }
}

/**
 * Called from the issue update path. A delivery with transferred obligations
 * cannot be closed without receipts, and its mapped stages cannot be removed
 * or changed by an ordinary policy edit.
 */
export async function assertIssueUpdateKeepsTransfers(
  tx: DbOrTx,
  input: {
    companyId: string;
    issueId: string;
    nextStatus: string | undefined;
    nextExecutionPolicy: Record<string, unknown> | null | undefined;
    clearsExecutionState?: boolean;
  },
) {
  const touching = await transfersTouching(tx, input.companyId, input.issueId);
  const heldSource = touching.find((row) => row.sourceIssueId === input.issueId && row.status === "held");
  if (heldSource) {
    // The source keeps its pending review as audited history; ordinary edits
    // must not close it or erase the stage the transfer points at.
    const nextPolicy = input.nextExecutionPolicy === undefined
      ? undefined
      : normalizeIssueExecutionPolicy(input.nextExecutionPolicy ?? null);
    const dropsHeldStage = nextPolicy !== undefined
      && !touching.filter((row) => row.sourceIssueId === input.issueId)
        .every((row) => nextPolicy?.stages.some((stage) => stage.id === row.sourceStageId));
    if (input.nextStatus === "done" || input.nextStatus === "cancelled" || input.clearsExecutionState || dropsHeldStage) {
      throw conflict("This task's review moved to the delivery. Its review history cannot be closed or cleared here.", {
        code: "review_transfer_source_held",
        transferId: heldSource.id,
        destinationIssueId: heldSource.destinationIssueId,
      });
    }
  }
  const rows = touching.filter((row) => row.destinationIssueId === input.issueId);
  if (rows.length === 0) return;
  if (input.nextStatus === "done") {
    const unproven = rows.find((row) => currentReceipt(row) === null);
    if (unproven) {
      throw conflict("A delivery with transferred reviews cannot close until their receipts are attached.", {
        code: "review_transfer_receipts_missing",
        transferId: unproven.id,
      });
    }
  }
  if (input.nextExecutionPolicy !== undefined) {
    const nextPolicy = normalizeIssueExecutionPolicy(input.nextExecutionPolicy ?? null);
    for (const row of rows) {
      const mapped = nextPolicy?.stages.find((stage) => stage.id === row.destinationStageId);
      const participants = (row.obligation.participants as Array<{ type: string; agentId: string | null; userId: string | null }>) ?? [];
      const preserved = mapped && participants.every((expected) => mapped.participants.some((actual) =>
        actual.type === expected.type && (actual.agentId ?? null) === (expected.agentId ?? null)
          && (actual.userId ?? null) === (expected.userId ?? null)));
      if (!preserved || mapped.participants.length !== participants.length) {
        throw conflict("A transferred review stage cannot be removed or changed by a policy edit.", {
          code: "review_transfer_stage_locked",
          transferId: row.id,
        });
      }
    }
  }
}

export type ReviewTransferHold = {
  transferId: string;
  destinationIssueId: string;
  sourceStageId: string;
};

/**
 * Returns the hold that stops `agentId` from being dispatched as the reviewer
 * of a transferred stage on `issueId`, or null. The source keeps its pending
 * state as history, so its recorded reviewer must never be woken for it again.
 * Other work on the source, such as its executor, is not held.
 */
export async function findReviewTransferHold(
  tx: DbOrTx,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<ReviewTransferHold | null> {
  const rows = await tx
    .select({
      transferId: issueReviewTransfers.id,
      destinationIssueId: issueReviewTransfers.destinationIssueId,
      sourceStageId: issueReviewTransfers.sourceStageId,
      obligation: issueReviewTransfers.obligation,
      executionState: issues.executionState,
    })
    .from(issueReviewTransfers)
    .innerJoin(issues, eq(issues.id, issueReviewTransfers.sourceIssueId))
    .where(and(
      eq(issueReviewTransfers.companyId, input.companyId),
      eq(issueReviewTransfers.sourceIssueId, input.issueId),
    ));
  for (const row of rows) {
    const state = parseIssueExecutionState(row.executionState);
    const participants = (row.obligation.participants as Array<{ agentId?: string | null }> | undefined) ?? [];
    const isStageReviewer = participants.some((participant) => participant.agentId === input.agentId)
      || (state?.currentStageId === row.sourceStageId && state.currentParticipant?.agentId === input.agentId);
    if (isStageReviewer) {
      return { transferId: row.transferId, destinationIssueId: row.destinationIssueId, sourceStageId: row.sourceStageId };
    }
  }
  return null;
}
