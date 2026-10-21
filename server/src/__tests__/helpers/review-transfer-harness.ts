import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import {
  activityLog,
  approvals,
  environmentLeases,
  environments,
  issueApprovals,
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
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueReviewTransferRoutes } from "../../routes/issue-review-transfers.js";
import { issueRoutes } from "../../routes/issues.js";

export const board = { type: "board", source: "local_implicit", userId: "local-board" };

/**
 * Shared embedded-Postgres harness for the review-transfer suites. Call it
 * inside a describe block: it registers the database lifecycle hooks and
 * returns the fixtures and request helpers bound to that database.
 */
export function useReviewTransferHarness() {
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

  return {
    get db() { return db; },
    sha,
    createApp,
    reviewStage,
    seedDelivery,
    transferBody,
    errorCode,
    expectNothingChanged,
    receiptBody,
    transferAndReadParent,
    startParentReview,
    boardReviewer,
    readManifest,
    bindingFor,
    approveParent,
  };
}

export type ReviewTransferFixture = Awaited<ReturnType<ReturnType<typeof useReviewTransferHarness>["seedDelivery"]>>;
