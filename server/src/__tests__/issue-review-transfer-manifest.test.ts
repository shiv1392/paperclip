import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  approvals,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueReviewTransfers,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { board, useReviewTransferHarness } from "./helpers/review-transfer-harness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue review transfer manifest", () => {
  const harness = useReviewTransferHarness();
  const { sha, createApp, reviewStage, seedDelivery, transferBody, errorCode, receiptBody, transferAndReadParent, startParentReview, boardReviewer, readManifest, bindingFor, approveParent } = harness;
  let db: typeof harness.db;
  beforeAll(() => {
    db = harness.db;
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

      it("rejects a source review edit after its transfer is satisfied", async () => {
        const { fixture, transfer } = await frozenAfter(1);
        const [row] = await db.select().from(issueReviewTransfers).where(eq(issueReviewTransfers.id, transfer.id));
        expect(row!.status).toBe("satisfied");
        const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
        const changed = { ...fixture.sourceStage, participants: [{ type: "agent", agentId: fixture.builderId }] };
        const response = await request(createApp())
          .patch(`/api/issues/${fixture.sourceId}`)
          .send({ executionPolicy: { mode: "normal", commentRequired: true, stages: [changed] } })
          .expect(409);
        expect(errorCode(response)).toBe("review_transfer_source_held");
        const [after] = await db.select().from(issues).where(eq(issues.id, fixture.sourceId));
        expect(after!.executionPolicy).toEqual(source!.executionPolicy);
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
});
