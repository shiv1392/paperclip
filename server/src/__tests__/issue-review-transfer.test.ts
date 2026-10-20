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
  issueExecutionDecisions,
  issueRelations,
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
});
