import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { board, useReviewTransferHarness } from "./helpers/review-transfer-harness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue review transfer hold and migration map", () => {
  const harness = useReviewTransferHarness();
  const { sha, createApp, reviewStage, seedDelivery, transferBody, errorCode, receiptBody, transferAndReadParent } = harness;
  let db: typeof harness.db;
  beforeAll(() => {
    db = harness.db;
  });
  describe("source dispatch hold", () => {
    async function heldFixture() {
      const fixture = await seedDelivery();
      const transfer = await transferAndReadParent(fixture);
      // Make the held review look dispatchable: in_review with the reviewer assigned.
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, fixture.sourceId));
      return { fixture, transfer };
    }

    async function runsFor(agentId: string, issueId: string) {
      return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter((run) => (run.contextSnapshot as { issueId?: string } | null)?.issueId === issueId);
    }

    it.each([
      ["assignment", "issue_assigned"],
      ["automation", "issue_blockers_resolved"],
      ["automation", "issue_monitor_due"],
      ["on_demand", "retry_failed_run"],
    ] as const)("skips a %s wake (%s) for the held reviewer without creating a run", async (wakeSource, reason) => {
      const { fixture, transfer } = await heldFixture();
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await heartbeat.wakeup(fixture.reviewerId, {
          source: wakeSource, triggerDetail: "system", reason,
          payload: { issueId: fixture.sourceId }, contextSnapshot: { issueId: fixture.sourceId },
          requestedByActorType: "system",
        });
      }
      expect(await runsFor(fixture.reviewerId, fixture.sourceId)).toHaveLength(0);
      const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixture.reviewerId)))
        .filter((wake) => (wake.payload as { issueId?: string } | null)?.issueId === fixture.sourceId);
      expect(wakes.length).toBeGreaterThan(0);
      expect(wakes.every((wake) => wake.status === "skipped" && wake.reason === "issue_review_transferred")).toBe(true);
      expect(wakes[0]!.payload).toMatchObject({ reviewTransfer: { transferId: transfer.id, destinationIssueId: fixture.parentId } });
      const [heldSource] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(heldSource!.executionState).toEqual(fixture.source.executionState);
    });

    it("cancels an already-queued reviewer run at claim time", async () => {
      const { fixture } = await heldFixture();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: fixture.companyId, agentId: fixture.reviewerId, invocationSource: "automation",
        status: "queued", runtimeMode: "legacy", contextSnapshot: { issueId: fixture.sourceId },
      });
      const adapter = createPostgresRunDispatchAdapter(db);
      expect(await adapter.cancelStaleQueuedRun({
        companyId: fixture.companyId, runId, expectedStatus: "queued", now: new Date(),
      })).toMatchObject({ outcome: "cancelled", errorCode: "issue_review_transferred" });
      // A held run never started, so the cancel must not ask the board to
      // reconcile provider actions: that is the deadlock this repair removes.
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled!)).toBe(false);
      expect(await getExecutionBlocker(db, fixture.companyId, fixture.sourceId)).toBeNull();
    });

    function releaseDrain() {
      return createReleaseIssueExecution({
        issueLock: createPostgresWakeQueueAdapter(db, {
          resolveResponsibleUserId: async () => "responsible-user",
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
        }),
        recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
      });
    }

    it("cancels a deferred reviewer wake instead of promoting it when execution is released", async () => {
      const { fixture } = await heldFixture();
      const finishedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: finishedRunId, companyId: fixture.companyId, agentId: fixture.builderId, invocationSource: "assignment",
        status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: fixture.sourceId },
      });
      const [deferred] = await db.insert(agentWakeupRequests).values({
        companyId: fixture.companyId, agentId: fixture.reviewerId, source: "automation", reason: "issue_commented",
        status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "responsible-user",
        payload: { issueId: fixture.sourceId },
      }).returning();
      const outcome = await releaseDrain()({
        companyId: fixture.companyId, runId: finishedRunId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true,
      });
      expect(outcome.outcome.kind).not.toBe("promoted");
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id));
      expect(after).toMatchObject({ status: "cancelled", runId: null });
      expect(await runsFor(fixture.reviewerId, fixture.sourceId)).toHaveLength(0);
    });

    it("does not escalate the held source as a stuck review participant", async () => {
      const { fixture } = await heldFixture();
      // A finished reviewer turn that still owns the source's execution lock,
      // as when a pre-transfer review wake completes after the transfer.
      const finishedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: finishedRunId, companyId: fixture.companyId, agentId: fixture.reviewerId, invocationSource: "assignment",
        status: "succeeded", finishedAt: new Date(),
        contextSnapshot: { issueId: fixture.sourceId, wakeReason: "execution_review_requested" },
      });
      await db.update(issues).set({ executionRunId: finishedRunId }).where(eq(issues.id, fixture.sourceId));
      const result = await releaseDrain()({ companyId: fixture.companyId, runId: finishedRunId, now: new Date() });
      expect(result.outcome.kind).toBe("released");
      const [heldSource] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(heldSource).toMatchObject({ status: "in_review", executionState: fixture.source.executionState });
      expect((await runsFor(fixture.reviewerId, fixture.sourceId)).map((run) => run.id)).toEqual([finishedRunId]);
    });

    it.each([
      ["closing the source", { status: "done", comment: "Close the child." }],
      ["clearing the source policy", { executionPolicy: null }],
      ["dropping the held source stage", { executionPolicy: { mode: "normal", commentRequired: true, stages: [] } }],
    ])("refuses %s while its review is transferred", async (_label, body) => {
      const { fixture } = await heldFixture();
      const response = await request(createApp())
        .patch(`/api/issues/${fixture.sourceId}`)
        .send(body)
        .expect(409);
      expect(errorCode(response)).toBe("review_transfer_source_held");
      const [heldSource] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(heldSource).toMatchObject({ executionState: fixture.source.executionState, executionPolicy: fixture.source.executionPolicy });
    });

    it("keeps repeated stranded-work sweeps from waking or escalating the held source", async () => {
      const { fixture } = await heldFixture();
      // The child reviewer is no longer invokable, which normally escalates a
      // pending review with no run as stranded.
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, fixture.reviewerId));
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      for (let sweep = 0; sweep < 2; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues();
      expect(await runsFor(fixture.reviewerId, fixture.sourceId)).toHaveLength(0);
      const wakes = (await db.select().from(agentWakeupRequests))
        .filter((wake) => (wake.payload as { issueId?: string } | null)?.issueId === fixture.sourceId);
      expect(wakes.filter((wake) => wake.status !== "skipped")).toHaveLength(0);
      const [heldSource] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(heldSource).toMatchObject({ status: "in_review", executionState: fixture.source.executionState });
      const recoveryChildren = await db.select().from(issues).where(eq(issues.parentId, fixture.sourceId));
      expect(recoveryChildren).toHaveLength(0);
    });

    it("refuses the wake-queue reopen write on a held source", async () => {
      const { fixture } = await heldFixture();
      // The exact write the deferred-wake reopen makes.
      await expect(issueService(db).updateForCompany(fixture.sourceId, fixture.companyId, { status: "todo", executionState: null }))
        .rejects.toMatchObject({ status: 409, details: { code: "review_transfer_source_held" } });
      const [heldSource] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(heldSource!.executionState).toEqual(fixture.source.executionState);
    });

    it("cancels a promoted scheduled retry for the held reviewer at claim time", async () => {
      const { fixture } = await heldFixture();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: fixture.companyId, agentId: fixture.reviewerId, invocationSource: "automation",
        status: "queued", runtimeMode: "legacy", scheduledRetryReason: "provider_overloaded", scheduledRetryAttempt: 1,
        contextSnapshot: { issueId: fixture.sourceId, wakeReason: "execution_review_requested" },
      } as any);
      const adapter = createPostgresRunDispatchAdapter(db);
      expect(await adapter.cancelStaleQueuedRun({
        companyId: fixture.companyId, runId, expectedStatus: "queued", now: new Date(),
      })).toMatchObject({ outcome: "cancelled", errorCode: "issue_review_transferred" });
    });

    it("still admits the executor on the held source", async () => {
      const { fixture } = await heldFixture();
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: fixture.builderId }).where(eq(issues.id, fixture.sourceId));
      // Occupy the executor's only slot so admission is real but no provider launches.
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, fixture.builderId));
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId: fixture.companyId, agentId: fixture.builderId, invocationSource: "manual", status: "running",
      });
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      await heartbeat.wakeup(fixture.builderId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: fixture.sourceId }, contextSnapshot: { issueId: fixture.sourceId },
        requestedByActorType: "system",
      });
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixture.builderId));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.status).not.toBe("skipped");
      expect(await runsFor(fixture.builderId, fixture.sourceId)).toHaveLength(1);
    });
  });

  describe("migration map", () => {
    it("maps the pending child and the final-suite child to distinct delivery stages ahead of its own gate, with the suite evidence attached later", async () => {
      const fixture = await seedDelivery();
      // The final-suite child has a configured review that has not started.
      const suiteStage = reviewStage(fixture.reviewerId);
      await db.update(issues).set({
        executionPolicy: { mode: "normal", commentRequired: true, stages: [suiteStage] },
      }).where(eq(issues.id, fixture.suiteId));
      const first = await request(createApp())
        .post(`/api/issues/${fixture.sourceId}/review-transfers`)
        .send(transferBody(fixture))
        .expect(201);
      const [suite] = await db.select().from(issues).where(eq(issues.id, fixture.suiteId));
      const [parentAfterFirst] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      const second = await request(createApp())
        .post(`/api/issues/${fixture.suiteId}/review-transfers`)
        .send({
          idempotencyKey: `transfer:${fixture.suiteId}:${suiteStage.id}`,
          sourceStageId: suiteStage.id,
          destinationIssueId: fixture.parentId,
          expectedSourceUpdatedAt: suite!.updatedAt.toISOString(),
          expectedDestinationUpdatedAt: parentAfterFirst!.updatedAt.toISOString(),
          removeBlocksIssueId: null,
          reason: "Move the not-started final-suite review to the delivery.",
          requiredReceipts: {
            commands: ["pnpm test:run"], originalBase: sha("base"), sourceCommit: sha("suite-commit"),
            sourceTree: sha("suite-tree"), childIssueIds: [fixture.suiteId, fixture.sourceId],
          },
        })
        .expect(201);
      expect(second.body.transfer.obligation.sourceStateStatus).toBe("none");
      // The final-suite obligation needs both child results; the source result alone is refused.
      const partial = await request(createApp())
        .post(`/api/review-transfers/${second.body.transfer.id}/receipts`)
        .send(receiptBody(fixture, {
          source: { issueId: fixture.suiteId, stageId: suiteStage.id, commit: sha("suite-commit"), tree: sha("suite-tree") },
          childResults: [{ issueId: fixture.suiteId, commit: sha("suite-commit"), includedInFinalHead: true }],
        }))
        .expect(422);
      expect(partial.body.details.problems).toContain(`missing required child result: ${fixture.sourceId}`);

      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      const stageIds = (parent!.executionPolicy as { stages: Array<{ id: string }> }).stages.map((stage) => stage.id);
      expect(stageIds).toEqual([
        second.body.transfer.destinationStageId,
        first.body.transfer.destinationStageId,
        fixture.parentGate.id,
      ]);
      expect(new Set(stageIds).size).toBe(3);
      // Only the circular pending-child -> suite-child edge is gone, so the suite child can run
      // its suite; its real dependency on the delivery remains.
      const edges = await db.select().from(issueRelations).where(eq(issueRelations.companyId, fixture.companyId));
      expect(edges.map((edge) => [edge.issueId, edge.relatedIssueId])).toEqual([[fixture.suiteId, fixture.parentId]]);
    });

    it("carries a child's changes-requested history to its delivery without approving it", async () => {
      const fixture = await seedDelivery();
      const decisionId = randomUUID();
      await db.insert(issueExecutionDecisions).values({
        id: decisionId, companyId: fixture.companyId, issueId: fixture.sourceId, stageId: fixture.sourceStage.id,
        stageType: "review", actorAgentId: fixture.reviewerId, outcome: "changes_requested", body: "Fix the changelog.",
      });
      const changesRequested = {
        ...(fixture.source.executionState as Record<string, unknown>),
        status: "changes_requested", lastDecisionId: decisionId, lastDecisionOutcome: "changes_requested", changesRequestedCount: 1,
      };
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: fixture.builderId, executionState: changesRequested })
        .where(eq(issues.id, fixture.sourceId));
      const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      const response = await request(createApp())
        .post(`/api/issues/${fixture.sourceId}/review-transfers`)
        .send(transferBody(fixture, { expectedSourceUpdatedAt: source!.updatedAt.toISOString(), removeBlocksIssueId: null }))
        .expect(201);
      expect(response.body.transfer.obligation).toMatchObject({
        sourceStateStatus: "changes_requested",
        decisionIds: [decisionId],
        decisionOutcomes: ["changes_requested"],
        changesRequestedCount: 1,
        returnAssignee: { type: "agent", agentId: fixture.builderId },
      });
      const decisions = await db.select().from(issueExecutionDecisions);
      expect(decisions.map((decision) => [decision.issueId, decision.outcome])).toEqual([[fixture.sourceId, "changes_requested"]]);
      const [after] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(after!.executionState).toEqual(changesRequested);
    });

    it("moves a pending child review onto a prepared delivery gate without touching that gate", async () => {
      const fixture = await seedDelivery();
      const response = await request(createApp())
        .post(`/api/issues/${fixture.sourceId}/review-transfers`)
        .send(transferBody(fixture, { removeBlocksIssueId: null }))
        .expect(201);
      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      const stages = (parent!.executionPolicy as { stages: unknown[] }).stages;
      expect(stages[1]).toEqual(fixture.parentGate);
      expect(parent!.status).toBe("blocked");
      expect(parent!.executionState).toBeNull();
      expect(response.body.transfer.obligation.sourceStateStatus).toBe("pending");
      // The scheduling edge was not named, so it stays.
      expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, fixture.companyId))).toHaveLength(2);
    });
  });
});
