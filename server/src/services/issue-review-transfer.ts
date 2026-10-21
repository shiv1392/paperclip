import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
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
  ExpectedReviewManifest,
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

/**
 * The destination's complete transfer set, read as one review manifest. The
 * server checks that the attested receipts agree with each other; it does not
 * read Git, so the reviewer verifies the pins themselves before approving.
 */
export type ReviewManifest = {
  destinationIssueId: string;
  revision: string | null;
  originalBase: string | null;
  finalHead: string | null;
  finalTree: string | null;
  transfers: Array<{
    transferId: string;
    destinationStageId: string;
    receiptRevision: string | null;
    sourceCommit: string | null;
    sourceTree: string | null;
  }>;
  valid: boolean;
  problems: string[];
};

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

/**
 * The canonical, comparable form of review configuration: stage ids, order,
 * type, approval count and participant principals, plus the round limit that
 * decides escalation. Participant row ids are left out because policy
 * normalization may regenerate them.
 */
function canonicalReview(policy: IssueExecutionPolicy | null, stageId?: string) {
  const stages = policyStages(policy).filter((stage) => stageId === undefined || stage.id === stageId);
  return JSON.stringify({
    maxReviewRounds: policy?.maxReviewRounds ?? null,
    stages: stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      approvalsNeeded: stage.approvalsNeeded,
      participants: stage.participants.map((participant) => ({
        type: participant.type,
        agentId: participant.agentId ?? null,
        userId: participant.userId ?? null,
      })),
    })),
  });
}

function samePrincipal(
  a: { type: string; agentId?: string | null; userId?: string | null } | null | undefined,
  b: { type: string; agentId?: string | null; userId?: string | null } | null | undefined,
) {
  if (!a || !b) return !a && !b;
  return a.type === b.type && (a.agentId ?? null) === (b.agentId ?? null) && (a.userId ?? null) === (b.userId ?? null);
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

type ReceiptPins = {
  source?: { commit?: string; tree?: string };
  destination?: { originalBase?: string; finalHead?: string; finalTree?: string };
};

export function buildReviewManifest(destinationIssueId: string, rows: IssueReviewTransferRow[]): ReviewManifest {
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const problems: string[] = [];
  const revisions = new Set(ordered.map((row) => row.manifestRevision));
  if (revisions.size > 1) problems.push("transfers disagree on the manifest revision");
  const pins = { originalBase: new Set<string>(), finalHead: new Set<string>(), finalTree: new Set<string>() };
  for (const row of ordered) {
    const receipt = currentReceipt(row) as ReceiptPins | null;
    if (!receipt) {
      problems.push(`missing receipts: ${row.id}`);
      continue;
    }
    for (const key of ["originalBase", "finalHead", "finalTree"] as const) {
      const value = receipt.destination?.[key];
      if (value) pins[key].add(value);
    }
  }
  const single = (values: Set<string>, label: string) => {
    if (values.size > 1) problems.push(`transfers disagree on the delivery ${label}`);
    return values.size === 1 ? [...values][0]! : null;
  };
  const originalBase = single(pins.originalBase, "original base");
  const finalHead = single(pins.finalHead, "final head");
  const finalTree = single(pins.finalTree, "final tree");
  return {
    destinationIssueId,
    revision: revisions.size === 1 ? [...revisions][0] ?? null : null,
    originalBase,
    finalHead,
    finalTree,
    transfers: ordered.map((row) => {
      const source = (currentReceipt(row) as ReceiptPins | null)?.source;
      return {
        transferId: row.id,
        destinationStageId: row.destinationStageId,
        receiptRevision: row.receiptRevision,
        sourceCommit: source?.commit ?? null,
        sourceTree: source?.tree ?? null,
      };
    }),
    valid: problems.length === 0 && ordered.length > 0,
    problems,
  };
}

/**
 * Locks the destination row, then its transfer rows in id order. Every writer
 * of the manifest and every bound approval takes the locks in this order, so
 * a receipt change and an approval cannot interleave.
 */
async function lockManifest(tx: Tx, companyId: string, destinationIssueId: string) {
  await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, destinationIssueId), eq(issues.companyId, companyId)))
    .for("update");
  return tx
    .select()
    .from(issueReviewTransfers)
    .where(and(
      eq(issueReviewTransfers.companyId, companyId),
      eq(issueReviewTransfers.destinationIssueId, destinationIssueId),
    ))
    .orderBy(asc(issueReviewTransfers.id))
    .for("update");
}

async function advanceManifestRevision(tx: Tx, companyId: string, destinationIssueId: string) {
  const revision = randomUUID();
  await tx
    .update(issueReviewTransfers)
    .set({ manifestRevision: revision })
    .where(and(
      eq(issueReviewTransfers.companyId, companyId),
      eq(issueReviewTransfers.destinationIssueId, destinationIssueId),
    ));
  return revision;
}

/**
 * True once any approval on the destination was bound to its manifest. A
 * settled transfer also freezes it: decision rows can be deleted with their
 * agent, but the settled status stays.
 */
async function manifestIsFrozen(tx: DbOrTx, companyId: string, destinationIssueId: string) {
  const [settled] = await tx
    .select({ id: issueReviewTransfers.id })
    .from(issueReviewTransfers)
    .where(and(
      eq(issueReviewTransfers.companyId, companyId),
      eq(issueReviewTransfers.destinationIssueId, destinationIssueId),
      eq(issueReviewTransfers.status, "satisfied"),
    ))
    .limit(1);
  if (settled) return true;
  const [bound] = await tx
    .select({ id: issueExecutionDecisions.id })
    .from(issueExecutionDecisions)
    .where(and(
      eq(issueExecutionDecisions.companyId, companyId),
      eq(issueExecutionDecisions.issueId, destinationIssueId),
      isNotNull(issueExecutionDecisions.reviewManifestBinding),
    ))
    .limit(1);
  return Boolean(bound);
}

function manifestFrozen(destinationIssueId: string) {
  return conflict("A review was already approved against this delivery's manifest. Its transfers and receipts can no longer change.", {
    code: "review_transfer_manifest_frozen",
    destinationIssueId,
  });
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
      if (await manifestIsFrozen(tx, input.companyId, destination.id)) throw manifestFrozen(destination.id);

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

      // An escalated review is held by a human outside the configured stage.
      // Copying the configured participants would hand it back to them.
      const currentParticipant = stageIsCurrent ? sourceState?.currentParticipant ?? null : null;
      if (currentParticipant && !sourceStage.participants.some((participant) => samePrincipal(participant, currentParticipant))) {
        throw conflict("The source review is escalated to a reviewer outside its stage. That reviewer must decide it on the source task.", {
          code: "review_transfer_source_escalated",
          currentParticipant,
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
            maxReviewRounds: sourcePolicy?.maxReviewRounds ?? null,
            currentStageId: sourceState?.currentStageId ?? null,
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
      const manifestRevision = await advanceManifestRevision(tx, input.companyId, destination.id);

      const details = {
        transferId: row!.id,
        sourceIssueId: source.id,
        sourceStageId: sourceStage.id,
        destinationIssueId: destination.id,
        destinationStageId: mappedStage.id,
        removedBlocksIssueId: removedEdge?.blockedId ?? null,
        reason: input.reason,
        manifestRevision,
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
      return { transfer: { ...row!, manifestRevision }, replayed: false };
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
    const incoming = rows.filter((row) => row.destinationIssueId === issueId);
    return {
      outgoing: rows.filter((row) => row.sourceIssueId === issueId),
      incoming,
      manifest: incoming.length > 0 ? buildReviewManifest(issueId, incoming) : null,
    };
  }

  async function attachReceipts(input: AttachReviewTransferReceiptsInput, actor: ReviewTransferActor) {
    return db.transaction(async (tx) => {
      const [target] = await tx
        .select({ destinationIssueId: issueReviewTransfers.destinationIssueId })
        .from(issueReviewTransfers)
        .where(and(eq(issueReviewTransfers.id, input.transferId), eq(issueReviewTransfers.companyId, input.companyId)));
      if (!target) throw notFound("Review transfer not found");
      const manifestRows = await lockManifest(tx, input.companyId, target.destinationIssueId);
      const row = manifestRows.find((candidate) => candidate.id === input.transferId);
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
      if (await manifestIsFrozen(tx, input.companyId, row.destinationIssueId)) throw manifestFrozen(row.destinationIssueId);
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
      const manifestRevision = await advanceManifestRevision(tx, row.companyId, row.destinationIssueId);
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
          details: {
            transferId: row.id,
            receiptRevision: revision,
            manifestRevision,
            finalHead: input.destination.finalHead,
            finalTree: input.destination.finalTree,
          },
        });
      }
      return { transfer: { ...updated!, manifestRevision }, replayed: false };
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
 * source stage may not be decided at all. On a delivery with transfers, any
 * approval needs a complete, consistent receipt set and must name the exact
 * manifest it was reviewed against; the returned binding is stored on the
 * decision row. An approval of the mapped stage marks the transfer satisfied.
 */
export async function assertReviewEligible(
  tx: Tx,
  input: {
    companyId: string;
    issueId: string;
    stageId: string;
    outcome: string;
    expectedReviewManifest?: ExpectedReviewManifest | null;
  },
): Promise<Record<string, unknown> | null> {
  const rows = await transfersTouching(tx, input.companyId, input.issueId);
  const heldSource = rows.find((row) => row.sourceIssueId === input.issueId && row.sourceStageId === input.stageId);
  if (heldSource) {
    throw conflict("This review was transferred to the delivery. Decide it on the delivery instead.", {
      code: "review_transfer_source_held",
      transferId: heldSource.id,
      destinationIssueId: heldSource.destinationIssueId,
    });
  }
  if (input.outcome !== "approved") return null;
  if (!rows.some((row) => row.destinationIssueId === input.issueId)) return null;
  // Re-read the manifest under its locks: a concurrent receipt change either
  // committed already and moved the revision, or waits for this decision.
  const manifestRows = await lockManifest(tx, input.companyId, input.issueId);
  const unproven = manifestRows.find((row) => currentReceipt(row) === null);
  if (unproven) {
    throw conflict("A transferred review cannot be approved until its receipts are attached.", {
      code: "review_transfer_receipts_missing",
      transferId: unproven.id,
    });
  }
  const manifest = buildReviewManifest(input.issueId, manifestRows);
  if (!manifest.valid) {
    throw conflict("The delivery's transfer receipts do not agree, so no review can be approved against them.", {
      code: "review_manifest_invalid",
      problems: manifest.problems,
    });
  }
  const expected = input.expectedReviewManifest;
  if (!expected) {
    throw unprocessable("Approving a delivery with transferred reviews requires expectedReviewManifest, which only PATCH /issues/:id accepts. Read GET /issues/:id/review-transfers and send its manifest revision, finalHead and finalTree.", {
      code: "review_manifest_binding_required",
      manifest,
    });
  }
  if (expected.revision !== manifest.revision || expected.finalHead !== manifest.finalHead
    || expected.finalTree !== manifest.finalTree) {
    throw conflict("The delivery's review manifest changed since it was read. Review the current manifest and approve again.", {
      code: "review_manifest_stale",
      expected,
      manifest,
    });
  }
  // Approving the mapped stage settles the moved obligation in the same
  // transaction as the decision. The source may then close; its reviewer
  // stays undispatched there, because the review was decided elsewhere.
  const decided = manifestRows.find((row) => row.destinationStageId === input.stageId);
  if (decided && decided.status === "held") {
    await tx
      .update(issueReviewTransfers)
      .set({ status: "satisfied", updatedAt: new Date() })
      .where(eq(issueReviewTransfers.id, decided.id));
  }
  return {
    destinationIssueId: manifest.destinationIssueId,
    revision: manifest.revision,
    originalBase: manifest.originalBase,
    finalHead: manifest.finalHead,
    finalTree: manifest.finalTree,
    transfers: manifest.transfers,
  };
}

/**
 * Called from the issue update path, with the issue row locked. A held source
 * cannot be closed or cleared, and its transferred stage, current reviewer,
 * current stage and return owner cannot change. A delivery with transfers
 * cannot close without receipts and decisions, and none of its review stages
 * can change: the obligations it holds are fixed when they are transferred.
 */
export async function assertIssueUpdateKeepsTransfers(
  tx: DbOrTx,
  input: {
    companyId: string;
    issueId: string;
    nextStatus: string | undefined;
    nextExecutionPolicy: Record<string, unknown> | null | undefined;
    nextExecutionState?: Record<string, unknown> | null;
  },
) {
  const touching = await transfersTouching(tx, input.companyId, input.issueId);
  if (touching.length === 0) return;
  const [current] = await tx
    .select({ executionPolicy: issues.executionPolicy, executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  const currentPolicy = normalizeIssueExecutionPolicy(current?.executionPolicy ?? null);
  const nextPolicy = input.nextExecutionPolicy === undefined
    ? currentPolicy
    : normalizeIssueExecutionPolicy(input.nextExecutionPolicy ?? null);

  const outgoing = touching.filter((row) => row.sourceIssueId === input.issueId);
  if (outgoing.length > 0) {
    const heldSource = outgoing.find((row) => row.status === "held");
    const sourceHeld = (transferId: string, destinationIssueId: string) =>
      conflict("This task's review moved to the delivery. Its review history cannot be closed, cleared or changed here.", {
        code: "review_transfer_source_held",
        transferId,
        destinationIssueId,
      });
    const clears = input.nextExecutionState === null && current?.executionState != null;
    if (heldSource && (input.nextStatus === "done" || input.nextStatus === "cancelled" || clears)) {
      throw sourceHeld(heldSource.id, heldSource.destinationIssueId);
    }
    const changedStage = outgoing.find((row) =>
      canonicalReview(currentPolicy, row.sourceStageId) !== canonicalReview(nextPolicy, row.sourceStageId));
    if (changedStage) throw sourceHeld(changedStage.id, changedStage.destinationIssueId);
    if (heldSource && input.nextExecutionState) {
      const before = parseIssueExecutionState(current?.executionState ?? null);
      const after = parseIssueExecutionState(input.nextExecutionState);
      if ((before?.currentStageId ?? null) !== (after?.currentStageId ?? null)
        || !samePrincipal(before?.currentParticipant, after?.currentParticipant)
        || !samePrincipal(before?.returnAssignee, after?.returnAssignee)) {
        throw sourceHeld(heldSource.id, heldSource.destinationIssueId);
      }
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
    // A board override clears the review state; it must not also skip a moved
    // obligation that no native decision has settled yet.
    const undecided = rows.find((row) => row.status === "held");
    if (undecided) {
      throw conflict("A delivery cannot close until each transferred review is approved on it.", {
        code: "review_transfer_undecided",
        transferId: undecided.id,
      });
    }
  }
  if (canonicalReview(currentPolicy) !== canonicalReview(nextPolicy)) {
    if (await manifestIsFrozen(tx, input.companyId, input.issueId)) throw manifestFrozen(input.issueId);
    throw conflict("The review stages of a delivery with transferred reviews cannot change.", {
      code: "review_transfer_stage_locked",
      transferId: rows[0]!.id,
    });
  }
}

/**
 * Called inside the issue delete transaction, after the issue row is locked.
 * A transfer is retained audit evidence for both of its issues, so neither
 * can be deleted while the transfer exists.
 */
export async function assertIssueDeletionKeepsTransfers(tx: Tx, input: { companyId: string; issueId: string }) {
  const [retained] = await transfersTouching(tx, input.companyId, input.issueId);
  if (retained) {
    throw conflict("This task is part of a review transfer, which must be kept as evidence. It cannot be deleted.", {
      code: "review_transfer_issue_retained",
      transferId: retained.id,
    });
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
