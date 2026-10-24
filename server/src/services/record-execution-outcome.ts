import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { ExecutionOutcomeReceipt, RecordExecutionOutcome } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { getConversationOwnershipBlocker, runUsedConversationAdapter } from "./conversation-continuation.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

/** Record an observed outcome on one settled source. This never admits work. */
export async function recordExecutionOutcome(input: {
  db: Db; companyId: string; issueId: string; actionId: string;
  actorId: string; decision: RecordExecutionOutcome;
}): Promise<{ receipt: ExecutionOutcomeReceipt; replayed: boolean }> {
  const { db, companyId, issueId, actionId, actorId, decision } = input;
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '5000', true)`);
    // Match execution settlement ordering. Parent FOR UPDATE locks also fence
    // new ownership/lease/action FK inserts while these proofs are checked.
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
    if (!task) throw notFound("Issue not found");
    const [source] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.id, actionId),
    ));
    if (!source) throw notFound("Recovery action not found");
    if (source.evidence.runId !== decision.runId) throw conflict("The decision must target this recovery action's exact run.");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, decision.runId),
    )).for("update");
    const [ownership] = await tx.select({ run: heartbeatRuns, controllerHeld: sql<boolean>`coalesce(
      ${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()
      OR (${heartbeatRuns.controllerBootId} is not null AND ${heartbeatRuns.controllerLeaseExpiresAt} is null), false)` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, decision.runId),
    )).for("update");
    const run = ownership?.run;
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.id, actionId),
    )).for("update");
    if (!action || action.evidence.runId !== decision.runId || !run ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId) throw conflict("The recorded execution source changed.");
    const previous = action.evidence.recordOnlyExecutionOutcome as ExecutionOutcomeReceipt | undefined;
    if (previous) {
      if (previous.schema !== "paperclip.record-execution-outcome.v1" || previous.companyId !== companyId || previous.issueId !== issueId ||
          previous.continuation !== "not_requested" || previous.providerStopped !== true || previous.actionId !== actionId || previous.runId !== decision.runId ||
          previous.actionOutcome !== decision.actionOutcome || previous.outcomeEvidence !== decision.outcomeEvidence) {
        throw conflict("This execution outcome is immutable. Inspect its existing receipt.");
      }
      return { receipt: previous, replayed: true };
    }
    const automatic = action.evidence.automaticRecovery as Record<string, unknown> | undefined;
    if (action.kind !== "active_run_watchdog" || action.cause !== "legacy_execution_requires_reconciliation" ||
        action.status !== "resolved" || !["blocked", "cancelled"].includes(action.outcome ?? "") ||
        automatic?.policy !== "preserve_without_replay_v1" || automatic.runId !== run.id || automatic.replay !== "blocked" ||
        action.evidence.executionReconciliation || action.evidence.continuationDelivery ||
        run.runtimeMode !== "legacy" || !run.startedAt || !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status) ||
        (!run.processPid && !run.processGroupId) || !await runUsedConversationAdapter(tx as unknown as Db, run) ||
        hasRequiredWorkspaceRecovery(action.evidence) || hasRequiredWorkspaceRecovery(run.resultJson) ||
        run.resultJson?.workspaceRestoreFailure || task.checkoutRunId === run.id || task.executionRunId === run.id) {
      throw conflict("This source is not a settled historical execution outcome. Use its supported recovery flow.");
    }
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
    )).orderBy(environmentLeases.id).for("update");
    if (ownership?.controllerHeld || coordinator?.leaseOwner || coordinator?.resultId || coordinator?.failureDetail?.successorRunId ||
        (coordinator && coordinator.phase !== "terminal_failure") ||
        leases.some(lease => !lease.releasedAt || (lease.provider !== "local" && !hasRemoteTerminationReceipt(lease))) ||
        await hasPendingRunCleanup(tx as unknown as Db, companyId, run.id) ||
        await getConversationOwnershipBlocker(tx as unknown as Db, companyId, issueId)) {
      throw conflict("The previous execution's ownership or cleanup is not verified. Its hold remains in place.");
    }
    const receipt: ExecutionOutcomeReceipt = {
      schema: "paperclip.record-execution-outcome.v1", id: randomUUID(), companyId, issueId, actionId,
      ...decision, actorId, recordedAt: new Date().toISOString(), continuation: "not_requested",
      sourceRecovery: { status: action.status, outcome: action.outcome, automaticRecovery: automatic },
    };
    await tx.update(issueRecoveryActions).set({ evidence: {
      ...action.evidence,
      automaticRecovery: { ...automatic, replay: "reconciled_record_only" },
      recordOnlyExecutionOutcome: receipt,
      continuationDelivery: "not_requested",
    } }).where(eq(issueRecoveryActions.id, actionId));
    await persistActivity(tx as unknown as Db, {
      companyId, actorType: "user", actorId, action: "issue.execution_outcome_recorded", entityType: "issue", entityId: issueId, runId: run.id,
      details: { receiptId: receipt.id, recoveryActionId: actionId, runId: run.id, actionOutcome: decision.actionOutcome, continuation: "not_requested" },
    });
    return { receipt, replayed: false };
  });
}
