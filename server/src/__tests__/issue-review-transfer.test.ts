import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  environmentLeases,
  environments,
  issueApprovals,
  issueComments,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issueReviewTransfers,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueReviewTransferRoutes } from "../routes/issue-review-transfers.js";
import { findReviewTransferHold } from "../services/issue-review-transfer.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const board = { type: "board", source: "local_implicit", userId: "local-board" };

describeEmbeddedPostgres("issue review transfers", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-transfers-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Issue routes wake reviewers after responding; let that work land before cleanup.
    let previous = -1;
    let stableChecks = 0;
    for (let attempt = 0; attempt < 40 && stableChecks < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [{ count }] = await db.execute<{ count: number }>(sql`select count(*)::int as count from agent_wakeup_requests`) as any;
      stableChecks = count === previous ? stableChecks + 1 : 0;
      previous = count;
    }
    await db.delete(issueReviewTransfers);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRunEvents);
    await db.execute(sql`update heartbeat_runs set retry_of_run_id = null`);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

  function createApp(actor: any = board) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueReviewTransferRoutes(db));
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  function reviewStage(reviewerId: string, reviewerUserId: string | null = null) {
    return {
      id: randomUUID(),
      type: "review" as const,
      approvalsNeeded: 1 as const,
      participants: [reviewerUserId
        ? { id: randomUUID(), type: "user" as const, agentId: null, userId: reviewerUserId }
        : { id: randomUUID(), type: "agent" as const, agentId: reviewerId, userId: null }],
    };
  }

  /**
   * Models a child with a pending reviewer stage that
   * blocks a sibling final-suite child, under a top-level delivery whose own
   * whole-delivery gate has not started.
   */
  async function seedDelivery(options: { reviewerUserId?: string } = {}) {
    const companyId = randomUUID();
    const prefix = `RT${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const reviewerId = randomUUID();
    const builderId = randomUUID();
    const responsibleUserId = `operator-${companyId.slice(0, 8)}`;
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Operator", email: `${responsibleUserId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Transfer Co", issuePrefix: prefix, defaultResponsibleUserId: responsibleUserId });
    if (options.reviewerUserId) {
      await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: options.reviewerUserId, status: "active", membershipRole: "owner",
      } as any);
    }
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Reviewer", role: "qa", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: builderId, companyId, name: "Builder", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const parentId = randomUUID();
    const sourceId = randomUUID();
    const suiteId = randomUUID();
    const reviewerUserId = options.reviewerUserId ?? null;
    const parentGate = reviewStage(reviewerId, reviewerUserId);
    const sourceStage = reviewStage(reviewerId, reviewerUserId);
    const builder = { type: "agent" as const, agentId: builderId, userId: null };
    const reviewer = reviewerUserId
      ? { type: "user" as const, agentId: null, userId: reviewerUserId }
      : { type: "agent" as const, agentId: reviewerId, userId: null };
    await db.insert(issues).values([
      {
        id: parentId, companyId, title: "Delivery", status: "blocked", priority: "medium",
        issueNumber: 1, identifier: `${prefix}-1`,
        executionPolicy: { mode: "normal", commentRequired: true, stages: [parentGate] },
      },
      {
        id: sourceId, companyId, parentId, title: "Child repair", status: "blocked", priority: "medium",
        assigneeAgentId: reviewerUserId ? null : reviewerId, assigneeUserId: reviewerUserId,
        issueNumber: 2, identifier: `${prefix}-2`,
        executionPolicy: { mode: "normal", commentRequired: true, stages: [sourceStage] },
        executionState: {
          status: "pending", currentStageId: sourceStage.id, currentStageIndex: 0, currentStageType: "review",
          currentParticipant: reviewer, returnAssignee: builder, reviewRequest: null,
          completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0,
        },
      },
      {
        id: suiteId, companyId, parentId, title: "Final suite", status: "blocked", priority: "medium",
        assigneeAgentId: builderId, issueNumber: 3, identifier: `${prefix}-3`,
      },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: sourceId, relatedIssueId: suiteId, type: "blocks" },
      { companyId, issueId: suiteId, relatedIssueId: parentId, type: "blocks" },
    ]);
    const [source] = await db.select().from(issues).where(eq(issues.id, sourceId));
    const [parent] = await db.select().from(issues).where(eq(issues.id, parentId));
    return { companyId, reviewerId, builderId, parentId, sourceId, suiteId, parentGate, sourceStage, source: source!, parent: parent! };
  }

  function transferBody(fixture: Awaited<ReturnType<typeof seedDelivery>>, overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: `transfer:${fixture.sourceId}:${fixture.sourceStage.id}`,
      sourceStageId: fixture.sourceStage.id,
      destinationIssueId: fixture.parentId,
      expectedSourceUpdatedAt: fixture.source.updatedAt.toISOString(),
      expectedDestinationUpdatedAt: fixture.parent.updatedAt.toISOString(),
      removeBlocksIssueId: fixture.suiteId,
      reason: "Move child review to the whole-delivery gate.",
      requiredReceipts: {
        commands: ["pnpm test:run"],
        originalBase: sha("base"),
        sourceCommit: sha("source-commit"),
        sourceTree: sha("source-tree"),
        childIssueIds: [fixture.sourceId],
      },
      ...overrides,
    };
  }

  function errorCode(response: { body: any }) {
    return response.body?.details?.code ?? response.body?.code;
  }

  async function expectNothingChanged(fixture: Awaited<ReturnType<typeof seedDelivery>>) {
    expect(await db.select().from(issueReviewTransfers)).toHaveLength(0);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect(source!.executionState).toEqual(fixture.source.executionState);
    expect(parent!.executionPolicy).toEqual(fixture.parent.executionPolicy);
    const edges = await db.select().from(issueRelations).where(eq(issueRelations.companyId, fixture.companyId));
    expect(edges).toHaveLength(2);
  }

  it("moves a pending child review to its own held stage on the top-level delivery", async () => {
    const fixture = await seedDelivery();

    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(201);

    const transferId = response.body.transfer.id;
    expect(response.body.transfer).toMatchObject({
      status: "held",
      sourceIssueId: fixture.sourceId,
      sourceStageId: fixture.sourceStage.id,
      destinationIssueId: fixture.parentId,
      removedBlockerIssueId: fixture.sourceId,
      removedBlockedIssueId: fixture.suiteId,
      receipts: [],
      obligation: {
        participants: [{ type: "agent", agentId: fixture.reviewerId }],
        approvalsNeeded: 1,
        returnAssignee: { type: "agent", agentId: fixture.builderId },
        sourceStateStatus: "pending",
        decisionIds: [],
        requiredReceipts: {
          commands: ["pnpm test:run"], originalBase: sha("base"), sourceCommit: sha("source-commit"),
          sourceTree: sha("source-tree"), childIssueIds: [fixture.sourceId],
        },
      },
    });

    // Source keeps its stage, state and decisions exactly.
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
    expect(source!.executionPolicy).toEqual(fixture.source.executionPolicy);
    expect(source!.executionState).toEqual(fixture.source.executionState);
    expect(source!.status).toBe("blocked");

    // Destination gains one mapped stage ahead of its untouched whole-delivery gate.
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    const stages = (parent!.executionPolicy as { stages: Array<{ id: string; participants: Array<{ agentId: string }> }> }).stages;
    expect(stages).toHaveLength(2);
    expect(stages[0]!.id).toBe(response.body.transfer.destinationStageId);
    expect(stages[0]!.participants.map((participant) => participant.agentId)).toEqual([fixture.reviewerId]);
    expect(stages[1]).toEqual(fixture.parentGate);

    // Only the named circular edge is removed.
    const edges = await db.select().from(issueRelations).where(eq(issueRelations.companyId, fixture.companyId));
    expect(edges.map((edge) => [edge.issueId, edge.relatedIssueId])).toEqual([[fixture.suiteId, fixture.parentId]]);

    // Both sides read the same transfer back.
    const sourceRead = await request(createApp()).get(`/api/issues/${fixture.sourceId}/review-transfers`).expect(200);
    const destinationRead = await request(createApp()).get(`/api/issues/${fixture.parentId}/review-transfers`).expect(200);
    expect(sourceRead.body.outgoing.map((transfer: { id: string }) => transfer.id)).toEqual([transferId]);
    expect(destinationRead.body.incoming.map((transfer: { id: string }) => transfer.id)).toEqual([transferId]);

    const audit = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.companyId),
      eq(activityLog.action, "issue.review_transferred"),
    ));
    // Source, delivery, and the sibling whose blocker was removed.
    expect(audit.map((entry) => entry.entityId).sort()).toEqual([fixture.sourceId, fixture.parentId, fixture.suiteId].sort());
  });
  it("rejects agents and leaves every record unchanged", async () => {
    const fixture = await seedDelivery();
    await request(createApp({ type: "agent", agentId: fixture.reviewerId, companyId: fixture.companyId, source: "agent_key" }))
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(403);
    await expectNothingChanged(fixture);
  });

  it("rejects a transfer from another company's board session", async () => {
    const fixture = await seedDelivery();
    const otherCompanyBoard = { type: "board", source: "session", userId: "outsider", companyIds: [randomUUID()], isInstanceAdmin: false };
    await request(createApp(otherCompanyBoard))
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(404);
    await expectNothingChanged(fixture);
  });

  it("rejects a destination that is not the top-level delivery above the source", async () => {
    const fixture = await seedDelivery();
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { destinationIssueId: fixture.suiteId }))
      .expect(422);
    expect(response.body.details?.code ?? response.body.code).toBe("review_transfer_invalid_destination");
    await expectNothingChanged(fixture);
  });

  it("rejects stale source evidence", async () => {
    const fixture = await seedDelivery();
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { expectedSourceUpdatedAt: new Date(0).toISOString() }))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_stale");
    await expectNothingChanged(fixture);
  });

  it("rejects a stage that is not the source's current pending stage", async () => {
    const fixture = await seedDelivery();
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { sourceStageId: randomUUID() }))
      .expect(422);
    expect(errorCode(response)).toBe("review_transfer_stage_not_found");
    await expectNothingChanged(fixture);
  });

  it("rejects while the source has a live run", async () => {
    const fixture = await seedDelivery();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: fixture.companyId, agentId: fixture.reviewerId,
      invocationSource: "assignment", status: "running", contextSnapshot: { issueId: fixture.sourceId },
    });
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_execution_active");
    await expectNothingChanged(fixture);
  });

  it("rejects while the destination has a pending human-only question", async () => {
    const fixture = await seedDelivery();
    await db.insert(issueThreadInteractions).values({
      companyId: fixture.companyId, issueId: fixture.parentId, kind: "ask_user_questions", status: "pending",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      payload: { version: 1, questions: [] },
    } as any);
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_human_control_pending");
    await expectNothingChanged(fixture);
  });

  it("rejects stale destination evidence", async () => {
    const fixture = await seedDelivery();
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { expectedDestinationUpdatedAt: new Date(0).toISOString() }))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_stale");
    await expectNothingChanged(fixture);
  });

  it("rejects while the source holds an active environment lease", async () => {
    const fixture = await seedDelivery();
    const [environment] = await db.insert(environments).values({
      companyId: fixture.companyId, name: "Lease env", driver: "local", config: {},
    } as any).returning();
    await db.insert(environmentLeases).values({
      companyId: fixture.companyId, environmentId: environment!.id, issueId: fixture.sourceId, status: "active",
    } as any);
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_lease_active");
    await expectNothingChanged(fixture);
  });

  it("rejects while the source has a pending board approval", async () => {
    const fixture = await seedDelivery();
    const [approval] = await db.insert(approvals).values({
      companyId: fixture.companyId, type: "request_board_approval", status: "pending", payload: {},
    } as any).returning();
    await db.insert(issueApprovals).values({ companyId: fixture.companyId, issueId: fixture.sourceId, approvalId: approval!.id });
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_human_control_pending");
    await expectNothingChanged(fixture);
  });

  it("checks access to the destination separately from the source", async () => {
    const fixture = await seedDelivery();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `OT${otherCompanyId.slice(0, 4)}` });
    const foreignDeliveryId = randomUUID();
    await db.insert(issues).values({ id: foreignDeliveryId, companyId: otherCompanyId, title: "Foreign delivery", status: "blocked" });
    const scopedBoard = { type: "board", source: "session", userId: "scoped", companyIds: [fixture.companyId], isInstanceAdmin: false };
    await request(createApp(scopedBoard))
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { destinationIssueId: foreignDeliveryId }))
      .expect(404);
    await expectNothingChanged(fixture);
  });

  it("treats an omitted and a null edge as the same replay", async () => {
    const fixture = await seedDelivery();
    const { removeBlocksIssueId: _edge, ...withoutEdge } = transferBody(fixture, { removeBlocksIssueId: null });
    const first = await request(createApp()).post(`/api/issues/${fixture.sourceId}/review-transfers`).send(withoutEdge).expect(201);
    const replay = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { removeBlocksIssueId: null }))
      .expect(200);
    expect(replay.body.transfer.id).toBe(first.body.transfer.id);
  });

  it("rolls back and keeps the edge when the named edge does not exist", async () => {
    const fixture = await seedDelivery();
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { removeBlocksIssueId: fixture.parentId }))
      .expect(422);
    expect(errorCode(response)).toBe("review_transfer_edge_not_found");
    await expectNothingChanged(fixture);
  });

  it("returns the original receipt on a same-key replay and creates nothing new", async () => {
    const fixture = await seedDelivery();
    const first = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(201);
    // Lost acknowledgement: the client resends the identical request.
    const replay = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(200);
    expect(replay.body).toMatchObject({ replayed: true, transfer: { id: first.body.transfer.id } });
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect((parent!.executionPolicy as { stages: unknown[] }).stages).toHaveLength(2);
    expect(await db.select().from(issueReviewTransfers)).toHaveLength(1);
  });

  it("rejects a reused key with a different request", async () => {
    const fixture = await seedDelivery();
    await request(createApp()).post(`/api/issues/${fixture.sourceId}/review-transfers`).send(transferBody(fixture)).expect(201);
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, { reason: "A different reason." }))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_idempotency_mismatch");
  });

  it("rejects a second transfer of the same stage under a new key", async () => {
    const fixture = await seedDelivery();
    await request(createApp()).post(`/api/issues/${fixture.sourceId}/review-transfers`).send(transferBody(fixture)).expect(201);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture, {
        idempotencyKey: "second-attempt",
        removeBlocksIssueId: null,
        expectedSourceUpdatedAt: source!.updatedAt.toISOString(),
        expectedDestinationUpdatedAt: parent!.updatedAt.toISOString(),
      }))
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_already_transferred");
    expect(await db.select().from(issueReviewTransfers)).toHaveLength(1);
  });

  it("creates exactly one transfer when two different keys race for the same stage", async () => {
    const fixture = await seedDelivery();
    const results = await Promise.all(["race-a", "race-b"].map((key) =>
      request(createApp())
        .post(`/api/issues/${fixture.sourceId}/review-transfers`)
        .send(transferBody(fixture, { idempotencyKey: key }))));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await db.select().from(issueReviewTransfers)).toHaveLength(1);
    const edges = await db.select().from(issueRelations).where(eq(issueRelations.companyId, fixture.companyId));
    expect(edges).toHaveLength(1);
  });
  function receiptBody(fixture: Awaited<ReturnType<typeof seedDelivery>>, overrides: Record<string, unknown> = {}) {
    const finalTree = sha("final-tree");
    return {
      idempotencyKey: `receipts:${fixture.sourceId}:1`,
      expectedReceiptRevision: null,
      source: { issueId: fixture.sourceId, stageId: fixture.sourceStage.id, commit: sha("source-commit"), tree: sha("source-tree") },
      destination: { originalBase: sha("base"), finalHead: sha("final-head"), finalTree },
      childResults: [{ issueId: fixture.sourceId, commit: sha("source-commit"), includedInFinalHead: true }],
      commands: [{ command: "pnpm test:run", exitCode: 0, logSha256: createHash("sha256").update("log").digest("hex"), testedTree: finalTree }],
      ...overrides,
    };
  }

  async function transferAndReadParent(fixture: Awaited<ReturnType<typeof seedDelivery>>) {
    const response = await request(createApp())
      .post(`/api/issues/${fixture.sourceId}/review-transfers`)
      .send(transferBody(fixture))
      .expect(201);
    return response.body.transfer as { id: string; destinationStageId: string };
  }

  async function startParentReview(fixture: Awaited<ReturnType<typeof seedDelivery>>) {
    const started = await request(createApp()).patch(`/api/issues/${fixture.parentId}`)
      .send({ status: "in_review", comment: "Delivery packet ready." });
    expect(started.status).toBe(200);
  }

  // The board user is the named reviewer so these tests reach the native
  // decision path; reviewer authority itself is covered by the policy tests.
  const boardReviewer = { ...board };

  async function readManifest(issueId: string) {
    const response = await request(createApp()).get(`/api/issues/${issueId}/review-transfers`).expect(200);
    return response.body.manifest as {
      revision: string; originalBase: string | null; finalHead: string | null; finalTree: string | null;
      transfers: Array<{ transferId: string; receiptRevision: string | null }>; valid: boolean; problems: string[];
    };
  }

  function bindingFor(manifest: { revision: string; finalHead: string | null; finalTree: string | null }) {
    return { revision: manifest.revision, finalHead: manifest.finalHead, finalTree: manifest.finalTree };
  }

  async function approveParent(fixture: Awaited<ReturnType<typeof seedDelivery>>, body: string) {
    const manifest = await readManifest(fixture.parentId);
    return request(createApp(boardReviewer))
      .patch(`/api/issues/${fixture.parentId}`)
      .send({ status: "done", comment: body, expectedReviewManifest: bindingFor(manifest) });
  }

  it("blocks approval of a transferred stage until a complete receipt set is attached", async () => {
    const fixture = await seedDelivery({ reviewerUserId: "local-board" });
    const transfer = await transferAndReadParent(fixture);
    await startParentReview(fixture);

    const [pending] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect((pending!.executionState as { currentStageId: string }).currentStageId).toBe(transfer.destinationStageId);

    const blocked = await request(createApp(boardReviewer))
      .patch(`/api/issues/${fixture.parentId}`)
      .send({ status: "done", comment: "Approved." })
      .expect(409);
    expect(errorCode(blocked)).toBe("review_transfer_receipts_missing");
    expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);

    await request(createApp())
      .post(`/api/review-transfers/${transfer.id}/receipts`)
      .send(receiptBody(fixture))
      .expect(201);

    expect((await approveParent(fixture, "Approved transferred child review.")).status).toBe(200);
    const decisions = await db.select().from(issueExecutionDecisions);
    expect(decisions.map((decision) => [decision.issueId, decision.stageId, decision.outcome]))
      .toEqual([[fixture.parentId, transfer.destinationStageId, "approved"]]);
    // The delivery's own gate is still next: one approval never covers two obligations.
    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect(afterFirst!.status).toBe("in_review");
    expect((afterFirst!.executionState as { currentStageId: string }).currentStageId).toBe(fixture.parentGate.id);

    // The delivery decided the moved obligation, so the child can now close.
    const [satisfied] = await db.select().from(issueReviewTransfers).where(eq(issueReviewTransfers.id, transfer.id));
    expect(satisfied!.status).toBe("satisfied");
    await request(createApp())
      .patch(`/api/issues/${fixture.sourceId}`)
      .send({ status: "cancelled", comment: "Approved on the delivery." })
      .expect(200);
    // History stays, and the reviewer is still never dispatched on the child.
    expect(await findReviewTransferHold(db, { companyId: fixture.companyId, issueId: fixture.sourceId, agentId: "local-board" }))
      .toBeNull();
  });

  it.each([
    ["a failed command", (body: any) => ({ ...body, commands: [{ ...body.commands[0], exitCode: 1 }] })],
    ["a command run on another tree", (body: any) => ({ ...body, commands: [{ ...body.commands[0], testedTree: "f".repeat(40) }] })],
    ["a missing required command", (body: any) => ({ ...body, commands: [{ ...body.commands[0], command: "pnpm build" }] })],
    ["a child result not in the final head", (body: any) => ({ ...body, childResults: [{ ...body.childResults[0], includedInFinalHead: false }] })],
    ["the wrong source stage", (body: any) => ({ ...body, source: { ...body.source, stageId: randomUUID() } })],
    ["a different original base", (body: any) => ({ ...body, destination: { ...body.destination, originalBase: sha("other-base") } })],
    ["a different source commit", (body: any) => ({
      ...body,
      source: { ...body.source, commit: sha("other-commit") },
      childResults: [{ ...body.childResults[0], commit: sha("other-commit") }],
    })],
    ["a different source tree", (body: any) => ({ ...body, source: { ...body.source, tree: sha("other-tree") } })],
  ])("rejects receipts with %s", async (_label, mutate) => {
    const fixture = await seedDelivery();
    const transfer = await transferAndReadParent(fixture);
    const response = await request(createApp())
      .post(`/api/review-transfers/${transfer.id}/receipts`)
      .send(mutate(receiptBody(fixture)))
      .expect(422);
    expect(errorCode(response)).toBe("review_transfer_receipts_invalid");
    const [row] = await db.select().from(issueReviewTransfers);
    expect(row!.receipts).toEqual([]);
  });

  it("appends receipt versions under an optimistic revision and keeps history", async () => {
    const fixture = await seedDelivery();
    const transfer = await transferAndReadParent(fixture);
    const first = await request(createApp())
      .post(`/api/review-transfers/${transfer.id}/receipts`)
      .send(receiptBody(fixture))
      .expect(201);
    const replay = await request(createApp())
      .post(`/api/review-transfers/${transfer.id}/receipts`)
      .send(receiptBody(fixture))
      .expect(200);
    expect(replay.body.transfer.receiptRevision).toBe(first.body.transfer.receiptRevision);

    const stale = await request(createApp())
      .post(`/api/review-transfers/${transfer.id}/receipts`)
      .send(receiptBody(fixture, { idempotencyKey: "receipts:2", expectedReceiptRevision: null }))
      .expect(409);
    expect(errorCode(stale)).toBe("review_transfer_receipts_stale");

    const second = await request(createApp())
      .post(`/api/review-transfers/${transfer.id}/receipts`)
      .send(receiptBody(fixture, { idempotencyKey: "receipts:2", expectedReceiptRevision: first.body.transfer.receiptRevision }))
      .expect(201);
    expect(second.body.transfer.receipts).toHaveLength(2);
  });

  it("routes a board close through the transferred stage instead of closing the delivery", async () => {
    const fixture = await seedDelivery();
    const transfer = await transferAndReadParent(fixture);
    await request(createApp())
      .patch(`/api/issues/${fixture.parentId}`)
      .send({ status: "done", comment: "Close it." })
      .expect(200);
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect(parent!.status).toBe("in_review");
    expect((parent!.executionState as { currentStageId: string }).currentStageId).toBe(transfer.destinationStageId);
  });

  it("refuses a board override that would close the delivery without receipts", async () => {
    const fixture = await seedDelivery();
    await transferAndReadParent(fixture);
    await startParentReview(fixture);
    // A board user who is not the pending reviewer can override a stage; the
    // transfer must still hold the delivery open.
    const closed = await request(createApp({ ...board, userId: "other-board-user" }))
      .patch(`/api/issues/${fixture.parentId}`)
      .send({ status: "done", comment: "Override and close." })
      .expect(409);
    expect(errorCode(closed)).toBe("review_transfer_receipts_missing");
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect(parent!.status).toBe("in_review");
  });

  it("refuses a policy edit that drops or changes a transferred stage", async () => {
    const fixture = await seedDelivery();
    const transfer = await transferAndReadParent(fixture);
    const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    const stages = (parent!.executionPolicy as { stages: any[] }).stages;
    for (const nextStages of [
      [fixture.parentGate],
      [{ ...stages[0], participants: [{ type: "agent", agentId: fixture.builderId }] }, fixture.parentGate],
    ]) {
      const response = await request(createApp())
        .patch(`/api/issues/${fixture.parentId}`)
        .send({ executionPolicy: { mode: "normal", commentRequired: true, stages: nextStages } })
        .expect(409);
      expect(errorCode(response)).toBe("review_transfer_stage_locked");
    }
    const [after] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
    expect((after!.executionPolicy as { stages: Array<{ id: string }> }).stages[0]!.id).toBe(transfer.destinationStageId);
  });

  it("refuses any decision on the held source stage", async () => {
    const fixture = await seedDelivery({ reviewerUserId: "local-board" });
    await transferAndReadParent(fixture);
    const response = await request(createApp(boardReviewer))
      .patch(`/api/issues/${fixture.sourceId}`)
      .send({ status: "done", comment: "Approve the child directly." })
      .expect(409);
    expect(errorCode(response)).toBe("review_transfer_source_held");
    expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
    expect(source!.executionState).toEqual(fixture.source.executionState);
  });
  describe("review manifest binding", () => {
    async function seedWithReceipts() {
      const fixture = await seedDelivery({ reviewerUserId: "local-board" });
      const transfer = await transferAndReadParent(fixture);
      const attached = await request(createApp())
        .post(`/api/review-transfers/${transfer.id}/receipts`)
        .send(receiptBody(fixture))
        .expect(201);
      await startParentReview(fixture);
      return { fixture, transfer, receiptRevision: attached.body.transfer.receiptRevision as string };
    }

    it("exposes the manifest identity, pins and per-transfer receipt revisions for reviewer readback", async () => {
      const { fixture, transfer, receiptRevision } = await seedWithReceipts();
      const manifest = await readManifest(fixture.parentId);
      expect(manifest).toMatchObject({
        originalBase: sha("base"), finalHead: sha("final-head"), finalTree: sha("final-tree"),
        transfers: [{ transferId: transfer.id, receiptRevision, sourceCommit: sha("source-commit"), sourceTree: sha("source-tree") }],
        valid: true, problems: [],
      });
      expect(manifest.revision).toEqual(expect.any(String));
      const sourceRead = await request(createApp()).get(`/api/issues/${fixture.sourceId}/review-transfers`).expect(200);
      expect(sourceRead.body.manifest).toBeNull();
    });

    it("rejects an approval without expectedReviewManifest and records no decision", async () => {
      const { fixture } = await seedWithReceipts();
      const response = await request(createApp(boardReviewer))
        .patch(`/api/issues/${fixture.parentId}`)
        .send({ status: "done", comment: "Approved." })
        .expect(422);
      expect(errorCode(response)).toBe("review_manifest_binding_required");
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
      const [transfer] = await db.select().from(issueReviewTransfers);
      expect(transfer!.status).toBe("held");
    });

    it("fails a review-approval comment closed, keeps no comment and names the PATCH path", async () => {
      const { fixture } = await seedWithReceipts();
      const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.parentId));
      const response = await request(createApp(boardReviewer))
        .post(`/api/issues/${fixture.parentId}/comments`)
        .send({ body: "## Review: APPROVED" })
        .expect(422);
      expect(errorCode(response)).toBe("review_manifest_binding_required");
      expect(response.body.error).toContain("PATCH /issues/:id");
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.parentId)))
        .toHaveLength(commentsBefore.length);
    });

    it.each([
      ["revision", (binding: any) => ({ ...binding, revision: randomUUID() })],
      ["final head", (binding: any) => ({ ...binding, finalHead: sha("other-head") })],
      ["final tree", (binding: any) => ({ ...binding, finalTree: sha("other-tree") })],
    ])("rejects an approval bound to a stale %s and records no decision", async (_label, mutate) => {
      const { fixture } = await seedWithReceipts();
      const manifest = await readManifest(fixture.parentId);
      const response = await request(createApp(boardReviewer))
        .patch(`/api/issues/${fixture.parentId}`)
        .send({ status: "done", comment: "Approved.", expectedReviewManifest: mutate(bindingFor(manifest)) })
        .expect(409);
      expect(errorCode(response)).toBe("review_manifest_stale");
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
    });

    it("rejects a binding that names a receipt revision replaced after it was read", async () => {
      const { fixture, transfer, receiptRevision } = await seedWithReceipts();
      const before = await readManifest(fixture.parentId);
      await request(createApp())
        .post(`/api/review-transfers/${transfer.id}/receipts`)
        .send(receiptBody(fixture, { idempotencyKey: "receipts:2", expectedReceiptRevision: receiptRevision }))
        .expect(201);
      const response = await request(createApp(boardReviewer))
        .patch(`/api/issues/${fixture.parentId}`)
        .send({ status: "done", comment: "Approved.", expectedReviewManifest: bindingFor(before) })
        .expect(409);
      expect(errorCode(response)).toBe("review_manifest_stale");
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
    });

    it("persists the exact manifest binding on each approval, including the delivery's own gate", async () => {
      const { fixture, transfer, receiptRevision } = await seedWithReceipts();
      const manifest = await readManifest(fixture.parentId);
      expect((await approveParent(fixture, "Approved transferred child review.")).status).toBe(200);
      expect((await approveParent(fixture, "Approved whole delivery.")).status).toBe(200);
      const decisions = await db.select().from(issueExecutionDecisions);
      const expected = {
        destinationIssueId: fixture.parentId,
        revision: manifest.revision,
        originalBase: sha("base"),
        finalHead: sha("final-head"),
        finalTree: sha("final-tree"),
        transfers: [{
          transferId: transfer.id, destinationStageId: transfer.destinationStageId, receiptRevision,
          sourceCommit: sha("source-commit"), sourceTree: sha("source-tree"),
        }],
      };
      expect(decisions.map((decision) => [decision.stageId, decision.outcome, decision.reviewManifestBinding]).sort())
        .toEqual([
          [transfer.destinationStageId, "approved", expected],
          [fixture.parentGate.id, "approved", expected],
        ].sort());
      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      expect(parent!.status).toBe("done");
    });

    it("rejects approval while two transfers attest different delivery trees", async () => {
      const fixture = await seedDelivery({ reviewerUserId: "local-board" });
      const suiteStage = reviewStage(fixture.reviewerId, "local-board");
      await db.update(issues).set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [suiteStage] } })
        .where(eq(issues.id, fixture.suiteId));
      const first = await transferAndReadParent(fixture);
      const [suite] = await db.select().from(issues).where(eq(issues.id, fixture.suiteId));
      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      const second = await request(createApp())
        .post(`/api/issues/${fixture.suiteId}/review-transfers`)
        .send({
          ...transferBody(fixture),
          idempotencyKey: `transfer:${fixture.suiteId}`,
          sourceStageId: suiteStage.id,
          expectedSourceUpdatedAt: suite!.updatedAt.toISOString(),
          expectedDestinationUpdatedAt: parent!.updatedAt.toISOString(),
          removeBlocksIssueId: null,
          requiredReceipts: { ...transferBody(fixture).requiredReceipts, childIssueIds: [fixture.suiteId] },
        })
        .expect(201);
      await request(createApp()).post(`/api/review-transfers/${first.id}/receipts`).send(receiptBody(fixture)).expect(201);
      const otherTree = sha("other-final-tree");
      await request(createApp())
        .post(`/api/review-transfers/${second.body.transfer.id}/receipts`)
        .send(receiptBody(fixture, {
          idempotencyKey: "receipts:suite",
          source: { issueId: fixture.suiteId, stageId: suiteStage.id, commit: sha("source-commit"), tree: sha("source-tree") },
          childResults: [{ issueId: fixture.suiteId, commit: sha("source-commit"), includedInFinalHead: true }],
          destination: { originalBase: sha("base"), finalHead: sha("final-head"), finalTree: otherTree },
          commands: [{ command: "pnpm test:run", exitCode: 0, logSha256: "a".repeat(64), testedTree: otherTree }],
        }))
        .expect(201);
      await startParentReview(fixture);

      const manifest = await readManifest(fixture.parentId);
      expect(manifest.valid).toBe(false);
      expect(manifest.problems).toContain("transfers disagree on the delivery final tree");
      const response = await request(createApp(boardReviewer))
        .patch(`/api/issues/${fixture.parentId}`)
        .send({
          status: "done", comment: "Approved.",
          expectedReviewManifest: { revision: manifest.revision, finalHead: sha("final-head"), finalTree: sha("final-tree") },
        })
        .expect(409);
      expect(errorCode(response)).toBe("review_manifest_invalid");
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
    });

    it("keeps the manifest revision on an identical receipt replay", async () => {
      const { fixture, transfer } = await seedWithReceipts();
      const before = await readManifest(fixture.parentId);
      const replay = await request(createApp())
        .post(`/api/review-transfers/${transfer.id}/receipts`)
        .send(receiptBody(fixture))
        .expect(200);
      expect(replay.body.replayed).toBe(true);
      expect((await readManifest(fixture.parentId)).revision).toBe(before.revision);
    });

    it("audits a receipt replacement made before any approval and moves the manifest revision", async () => {
      const { fixture, transfer, receiptRevision } = await seedWithReceipts();
      const before = await readManifest(fixture.parentId);
      const newHead = sha("final-head-2");
      const newTree = sha("final-tree-2");
      await request(createApp())
        .post(`/api/review-transfers/${transfer.id}/receipts`)
        .send(receiptBody(fixture, {
          idempotencyKey: "receipts:2",
          expectedReceiptRevision: receiptRevision,
          destination: { originalBase: sha("base"), finalHead: newHead, finalTree: newTree },
          commands: [{ command: "pnpm test:run", exitCode: 0, logSha256: "b".repeat(64), testedTree: newTree }],
        }))
        .expect(201);
      const after = await readManifest(fixture.parentId);
      expect(after.revision).not.toBe(before.revision);
      expect(after).toMatchObject({ finalHead: newHead, finalTree: newTree, valid: true });
      const [row] = await db.select().from(issueReviewTransfers);
      expect(row!.receipts).toHaveLength(2);
      const audit = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, fixture.companyId),
        eq(activityLog.action, "issue.review_transfer_receipts_attached"),
        eq(activityLog.entityId, fixture.parentId),
      ));
      expect(audit.map((entry) => (entry.details as { manifestRevision: string }).manifestRevision).sort())
        .toEqual([before.revision, after.revision].sort());
    });

    describe("freeze after the first bound approval", () => {
      async function frozenAfter(approvals: 1 | 2) {
        const seeded = await seedWithReceipts();
        for (let index = 0; index < approvals; index += 1) {
          expect((await approveParent(seeded.fixture, `Approval ${index + 1}.`)).status).toBe(200);
        }
        return seeded;
      }

      it.each([
        ["one mapped approval", 1],
        ["the delivery's own approval", 2],
      ] as const)("rejects receipt replacement after %s", async (_label, approvals) => {
        const { fixture, transfer, receiptRevision } = await frozenAfter(approvals);
        const decisionsBefore = await db.select().from(issueExecutionDecisions);
        const response = await request(createApp())
          .post(`/api/review-transfers/${transfer.id}/receipts`)
          .send(receiptBody(fixture, { idempotencyKey: "receipts:late", expectedReceiptRevision: receiptRevision }))
          .expect(409);
        expect(errorCode(response)).toBe("review_transfer_manifest_frozen");
        const [row] = await db.select().from(issueReviewTransfers);
        expect(row!.receipts).toHaveLength(1);
        expect(row!.receiptRevision).toBe(receiptRevision);
        expect(await db.select().from(issueExecutionDecisions)).toEqual(decisionsBefore);
      });

      it("stays frozen after the bound decision rows are removed", async () => {
        const { fixture, transfer, receiptRevision } = await frozenAfter(1);
        // Agent deletion removes that agent's decision rows; the freeze must not depend on them.
        await db.delete(issueExecutionDecisions);
        const response = await request(createApp())
          .post(`/api/review-transfers/${transfer.id}/receipts`)
          .send(receiptBody(fixture, { idempotencyKey: "receipts:after-delete", expectedReceiptRevision: receiptRevision }))
          .expect(409);
        expect(errorCode(response)).toBe("review_transfer_manifest_frozen");
      });

      it("still returns the original receipt for an identical replay after approval", async () => {
        const { fixture, transfer, receiptRevision } = await frozenAfter(1);
        const replay = await request(createApp())
          .post(`/api/review-transfers/${transfer.id}/receipts`)
          .send(receiptBody(fixture))
          .expect(200);
        expect(replay.body.transfer.receiptRevision).toBe(receiptRevision);
      });

      it("rejects a new transfer onto the delivery after all mapped approvals", async () => {
        const { fixture } = await frozenAfter(1);
        const suiteStage = reviewStage(fixture.reviewerId);
        await db.update(issues).set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [suiteStage] } })
          .where(eq(issues.id, fixture.suiteId));
        const [suite] = await db.select().from(issues).where(eq(issues.id, fixture.suiteId));
        const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
        const response = await request(createApp())
          .post(`/api/issues/${fixture.suiteId}/review-transfers`)
          .send({
            ...transferBody(fixture),
            idempotencyKey: "transfer:late",
            sourceStageId: suiteStage.id,
            expectedSourceUpdatedAt: suite!.updatedAt.toISOString(),
            expectedDestinationUpdatedAt: parent!.updatedAt.toISOString(),
            removeBlocksIssueId: null,
            requiredReceipts: { ...transferBody(fixture).requiredReceipts, childIssueIds: [fixture.suiteId] },
          })
          .expect(409);
        expect(errorCode(response)).toBe("review_transfer_manifest_frozen");
        expect(await db.select().from(issueReviewTransfers)).toHaveLength(1);
        // The sibling's blocker edge to the delivery is unrelated and stays.
        const edges = await db.select().from(issueRelations).where(eq(issueRelations.companyId, fixture.companyId));
        expect(edges.map((edge) => [edge.issueId, edge.relatedIssueId])).toEqual([[fixture.suiteId, fixture.parentId]]);
      });

      it("rejects a stage configuration change after a bound approval", async () => {
        const { fixture } = await frozenAfter(1);
        const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
        const policy = parent!.executionPolicy as { stages: any[] };
        const changedGate = { ...policy.stages[1], participants: [{ type: "agent", agentId: fixture.builderId }] };
        const response = await request(createApp())
          .patch(`/api/issues/${fixture.parentId}`)
          .send({ executionPolicy: { ...policy, stages: [policy.stages[0], changedGate] } })
          .expect(409);
        expect(errorCode(response)).toBe("review_transfer_manifest_frozen");
        const [after] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
        expect(after!.executionPolicy).toEqual(parent!.executionPolicy);
      });
    });

    it("refuses a board override that would close the delivery before the moved review is decided", async () => {
      const { fixture } = await seedWithReceipts();
      const closed = await request(createApp({ ...board, userId: "other-board-user" }))
        .patch(`/api/issues/${fixture.parentId}`)
        .send({ status: "done", comment: "Override and close." })
        .expect(409);
      expect(errorCode(closed)).toBe("review_transfer_undecided");
      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      expect(parent!.status).toBe("in_review");
    });
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
