import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
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
    await db.delete(issueReviewTransfers);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: any = board) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueReviewTransferRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function reviewStage(reviewerId: string) {
    return {
      id: randomUUID(),
      type: "review" as const,
      approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "agent" as const, agentId: reviewerId, userId: null }],
    };
  }

  /**
   * Mirrors ORI-207 -> ORI-61: a child with a pending reviewer stage that
   * blocks a sibling final-suite child, under a top-level delivery whose own
   * whole-delivery gate has not started.
   */
  async function seedDelivery() {
    const companyId = randomUUID();
    const prefix = `RT${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const reviewerId = randomUUID();
    const builderId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Transfer Co", issuePrefix: prefix });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Lucas", role: "qa", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: builderId, companyId, name: "Simon", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const parentId = randomUUID();
    const sourceId = randomUUID();
    const suiteId = randomUUID();
    const parentGate = reviewStage(reviewerId);
    const sourceStage = reviewStage(reviewerId);
    const builder = { type: "agent" as const, agentId: builderId, userId: null };
    const reviewer = { type: "agent" as const, agentId: reviewerId, userId: null };
    await db.insert(issues).values([
      {
        id: parentId, companyId, title: "Delivery", status: "blocked", priority: "medium",
        issueNumber: 1, identifier: `${prefix}-1`,
        executionPolicy: { mode: "normal", commentRequired: true, stages: [parentGate] },
      },
      {
        id: sourceId, companyId, parentId, title: "Child repair", status: "blocked", priority: "medium",
        assigneeAgentId: reviewerId, issueNumber: 2, identifier: `${prefix}-2`,
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
      requiredReceipts: { commands: ["pnpm test:run"] },
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
        requiredReceipts: { commands: ["pnpm test:run"] },
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
    expect(audit).toHaveLength(2);
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
});
