import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  approvals,
  environmentLeases,
  environments,
  issueApprovals,
  agents,
  companies,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issueReviewTransfers,
  issues,
} from "@paperclipai/db";
import { findReviewTransferHold } from "../services/issue-review-transfer.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { board, useReviewTransferHarness } from "./helpers/review-transfer-harness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue review transfers", () => {
  const harness = useReviewTransferHarness();
  const { sha, createApp, reviewStage, seedDelivery, transferBody, errorCode, expectNothingChanged, receiptBody, transferAndReadParent, startParentReview, boardReviewer, approveParent } = harness;
  let db: typeof harness.db;
  beforeAll(() => {
    db = harness.db;
  });
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

  describe("retained obligations", () => {
    async function expectTransferIntact(fixture: Awaited<ReturnType<typeof seedDelivery>>, transferId: string) {
      const [row] = await db.select().from(issueReviewTransfers).where(eq(issueReviewTransfers.id, transferId));
      expect(row).toMatchObject({ status: "held", sourceIssueId: fixture.sourceId, destinationIssueId: fixture.parentId });
      const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      expect(source!.executionState).toEqual(fixture.source.executionState);
      expect((parent!.executionPolicy as { stages: Array<{ id: string }> }).stages.map((stage) => stage.id))
        .toEqual([row!.destinationStageId, fixture.parentGate.id]);
    }

    it.each(["source", "destination"] as const)("refuses to delete the %s of a transfer and keeps its obligation", async (role) => {
      const fixture = await seedDelivery();
      const transfer = await transferAndReadParent(fixture);
      const response = await request(createApp())
        .delete(`/api/issues/${role === "source" ? fixture.sourceId : fixture.parentId}`)
        .expect(409);
      expect(errorCode(response)).toBe("review_transfer_issue_retained");
      await expectTransferIntact(fixture, transfer.id);
    });

    it("refuses to transfer a source review escalated to a human outside its stage", async () => {
      const fixture = await seedDelivery();
      const escalatedState = {
        ...(fixture.source.executionState as Record<string, unknown>),
        currentParticipant: { type: "user", agentId: null, userId: "escalation-owner" },
        changesRequestedCount: 3,
      };
      await db.update(issues).set({ executionState: escalatedState, assigneeAgentId: null, assigneeUserId: "escalation-owner" })
        .where(eq(issues.id, fixture.sourceId));
      const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      const response = await request(createApp())
        .post(`/api/issues/${fixture.sourceId}/review-transfers`)
        .send(transferBody(fixture, { expectedSourceUpdatedAt: source!.updatedAt.toISOString() }))
        .expect(409);
      expect(errorCode(response)).toBe("review_transfer_source_escalated");
      expect(await db.select().from(issueReviewTransfers)).toHaveLength(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(after!.executionState).toEqual(escalatedState);
      expect(after!.assigneeUserId).toBe("escalation-owner");
    });

    it.each([
      ["a changed reviewer", (fixture: Awaited<ReturnType<typeof seedDelivery>>) => ({
        stages: [{ ...fixture.sourceStage, participants: [{ type: "agent", agentId: fixture.builderId }] }],
      })],
      ["a changed round limit", (fixture: Awaited<ReturnType<typeof seedDelivery>>) => ({
        stages: [fixture.sourceStage], maxReviewRounds: 1,
      })],
      ["a stage added before it", (fixture: Awaited<ReturnType<typeof seedDelivery>>) => ({
        stages: [reviewStage(fixture.builderId), fixture.sourceStage],
      })],
    ] as const)("refuses a source policy edit with %s", async (_label, policyFor) => {
      const fixture = await seedDelivery();
      const transfer = await transferAndReadParent(fixture);
      const response = await request(createApp())
        .patch(`/api/issues/${fixture.sourceId}`)
        .send({ executionPolicy: { mode: "normal", commentRequired: true, ...policyFor(fixture) } })
        .expect(409);
      expect(errorCode(response)).toBe("review_transfer_source_held");
      const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
      expect(source!.executionPolicy).toEqual(fixture.source.executionPolicy);
      await expectTransferIntact(fixture, transfer.id);
    });

    it.each([
      ["the existing gate's reviewer", (fixture: Awaited<ReturnType<typeof seedDelivery>>, stages: any[]) => ({
        stages: [stages[0], { ...fixture.parentGate, participants: [{ type: "agent", agentId: fixture.builderId }] }],
      })],
      ["an added stage", (fixture: Awaited<ReturnType<typeof seedDelivery>>, stages: any[]) => ({
        stages: [...stages, reviewStage(fixture.builderId)],
      })],
      ["the round limit", (_fixture: Awaited<ReturnType<typeof seedDelivery>>, stages: any[]) => ({
        stages, maxReviewRounds: 1,
      })],
    ] as const)("refuses a delivery policy edit to %s before any approval", async (_label, policyFor) => {
      const fixture = await seedDelivery();
      const transfer = await transferAndReadParent(fixture);
      const [parent] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      const stages = (parent!.executionPolicy as { stages: any[] }).stages;
      const response = await request(createApp())
        .patch(`/api/issues/${fixture.parentId}`)
        .send({ executionPolicy: { mode: "normal", commentRequired: true, ...policyFor(fixture, stages) } })
        .expect(409);
      expect(errorCode(response)).toBe("review_transfer_stage_locked");
      const [after] = await db.select().from(issues).where(eq(issues.id, fixture.parentId));
      expect(after!.executionPolicy).toEqual(parent!.executionPolicy);
      await expectTransferIntact(fixture, transfer.id);
    });

    it.each(["source", "destination"] as const)("keeps one coherent outcome when a %s policy edit races the transfer", async (role) => {
      const fixture = await seedDelivery();
      const issueId = role === "source" ? fixture.sourceId : fixture.parentId;
      const original = role === "source" ? fixture.sourceStage : fixture.parentGate;
      const changed = { ...original, participants: [{ type: "agent", agentId: fixture.builderId }] };
      const [transfer, edit] = await Promise.all([
        request(createApp()).post(`/api/issues/${fixture.sourceId}/review-transfers`).send(transferBody(fixture)),
        request(createApp()).patch(`/api/issues/${issueId}`)
          .send({ executionPolicy: { mode: "normal", commentRequired: true, stages: [changed] } }),
      ]);
      const rows = await db.select().from(issueReviewTransfers);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      const stages = (after!.executionPolicy as { stages: Array<{ id: string; participants: Array<{ agentId: string | null }> }> }).stages;
      const stage = stages.find((candidate) => candidate.id === original.id)!;
      if (transfer.status === 201) {
        // Transfer committed first: the edit must not have changed the held configuration.
        expect(edit.status).toBe(409);
        expect(rows).toHaveLength(1);
        expect(stage.participants.map((participant) => participant.agentId)).toEqual([fixture.reviewerId]);
      } else {
        // Edit committed first: the transfer saw stale evidence and changed nothing.
        expect(edit.status).toBe(200);
        expect(errorCode(transfer)).toBe("review_transfer_stale");
        expect(rows).toHaveLength(0);
        expect(stage.participants.map((participant) => participant.agentId)).toEqual([fixture.builderId]);
      }
    });
  });
});
