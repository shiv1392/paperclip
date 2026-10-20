import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueExecutionDecisions, issueReviewTransfers, issues } from "@paperclipai/db";
import { buildExecutionPolicy } from "../../../ui/src/lib/issue-execution-policy.ts";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { assertReviewEligible, issueReviewTransferService } from "../services/issue-review-transfer.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("edited execution policy persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-policy-persistence-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["reviewer", "monitor"] as const)("retains the independent review limit after removing the last %s", async (removed) => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const original = normalizeIssueExecutionPolicy({
      maxReviewRounds: 4,
      ...(removed === "monitor"
        ? { monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" } }
        : { stages: [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }] }),
    });
    await db.insert(companies).values({ id: companyId, name: "Policy fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review limit fixture", executionPolicy: original });
    const edited = buildExecutionPolicy({ existingPolicy: original, reviewerValues: [], approverValues: [] })!;
    // The monitor editor removes this key after building the unchanged stages.
    const { monitor: _removedMonitor, ...withoutMonitor } = edited;
    const normalized = normalizeIssueExecutionPolicy(removed === "monitor" ? withoutMonitor : edited);
    const service = issueService(db);
    await service.update(issueId, { executionPolicy: normalized, companyGuard: companyId });
    const saved = await service.getById(issueId);
    expect(saved?.executionPolicy).toEqual({ mode: "normal", commentRequired: true, stages: [], maxReviewRounds: 4 });

    const restored = normalizeIssueExecutionPolicy(buildExecutionPolicy({
      existingPolicy: saved?.executionPolicy,
      reviewerValues: ["user:board-reviewer"], approverValues: [],
    }));
    expect(restored).toMatchObject({ maxReviewRounds: 4, stages: [{ type: "review" }] });
  });
});

(support.supported ? describe : describe.skip)("review manifest binding persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-manifest-binding-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");
  const actor = { userId: "local-board", agentId: null, runId: null };

  async function seed() {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const sourceId = randomUUID();
    const sourceStageId = randomUUID();
    const destinationStageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding fixture", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Delivery" },
      { id: sourceId, companyId, parentId, title: "Child" },
    ]);
    const tree = sha("final-tree");
    const receiptRevision = randomUUID();
    const manifestRevision = randomUUID();
    const [transfer] = await db.insert(issueReviewTransfers).values({
      companyId, sourceIssueId: sourceId, sourceStageId, destinationIssueId: parentId, destinationStageId,
      idempotencyKey: `t:${sourceId}`, requestFingerprint: "f", reason: "fixture",
      obligation: {
        participants: [],
        requiredReceipts: {
          commands: ["pnpm test:run"], originalBase: sha("base"), sourceCommit: sha("commit"), sourceTree: sha("tree"),
          childIssueIds: [sourceId],
        },
      },
      receipts: [{ revision: receiptRevision, idempotencyKey: "r:1", destination: { originalBase: sha("base"), finalHead: sha("final-head"), finalTree: tree } }],
      receiptRevision,
      manifestRevision,
    }).returning();
    return { companyId, parentId, sourceId, sourceStageId, destinationStageId, transfer: transfer!, receiptRevision, manifestRevision };
  }

  function replacement(fixture: Awaited<ReturnType<typeof seed>>) {
    const tree = sha("final-tree-2");
    return {
      companyId: fixture.companyId,
      transferId: fixture.transfer.id,
      idempotencyKey: "r:2",
      expectedReceiptRevision: fixture.receiptRevision,
      source: { issueId: fixture.sourceId, stageId: fixture.sourceStageId, commit: sha("commit"), tree: sha("tree") },
      destination: { originalBase: sha("base"), finalHead: sha("final-head-2"), finalTree: tree },
      childResults: [{ issueId: fixture.sourceId, commit: sha("commit"), includedInFinalHead: true }],
      commands: [{ command: "pnpm test:run", exitCode: 0, logSha256: "c".repeat(64), testedTree: tree }],
    };
  }

  /** Records an approval through the same eligibility seam and insert the issue routes use. */
  function approve(fixture: Awaited<ReturnType<typeof seed>>, afterLocks: () => Promise<void> = async () => {}) {
    return db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, fixture.parentId)).for("update");
      const reviewManifestBinding = await assertReviewEligible(tx, {
        companyId: fixture.companyId,
        issueId: fixture.parentId,
        stageId: fixture.destinationStageId,
        outcome: "approved",
        expectedReviewManifest: { revision: fixture.manifestRevision, finalHead: sha("final-head"), finalTree: sha("final-tree") },
      });
      await tx.insert(issueExecutionDecisions).values({
        companyId: fixture.companyId, issueId: fixture.parentId, stageId: fixture.destinationStageId,
        stageType: "review", actorUserId: "local-board", outcome: "approved", body: "Approved.", reviewManifestBinding,
      });
      await afterLocks();
    });
  }

  async function waitForLockWaiters(count: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await db.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`) as unknown as Array<{ waiting: number }>;
      if ((rows[0]?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} lock waiter(s)`);
  }

  async function codeOf(promise: Promise<unknown>) {
    try {
      await promise;
      return "resolved";
    } catch (error) {
      return (error as { details?: { code?: string } }).details?.code ?? String(error);
    }
  }

  it("rejects a receipt replacement that waits behind a committing approval", async () => {
    const fixture = await seed();
    const transfers = issueReviewTransferService(db);
    let attach: Promise<unknown> | null = null;
    await approve(fixture, async () => {
      attach = transfers.attachReceipts(replacement(fixture), actor);
      await waitForLockWaiters(1);
    });
    expect(await codeOf(attach!)).toBe("review_transfer_manifest_frozen");

    const [decision] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.parentId));
    expect(decision!.reviewManifestBinding).toEqual({
      destinationIssueId: fixture.parentId,
      revision: fixture.manifestRevision,
      originalBase: sha("base"),
      finalHead: sha("final-head"),
      finalTree: sha("final-tree"),
      transfers: [{ transferId: fixture.transfer.id, destinationStageId: fixture.destinationStageId, receiptRevision: fixture.receiptRevision }],
    });
    const [row] = await db.select().from(issueReviewTransfers).where(eq(issueReviewTransfers.id, fixture.transfer.id));
    expect(row!.receipts).toHaveLength(1);
    expect(row!.manifestRevision).toBe(fixture.manifestRevision);
    expect(row!.status).toBe("satisfied");
  });

  it("rejects an approval that waits behind a committing receipt replacement", async () => {
    const fixture = await seed();
    const transfers = issueReviewTransferService(db);
    let attach: Promise<unknown> | null = null;
    let decision: Promise<unknown> | null = null;
    // Hold the destination lock so the replacement queues first, then the approval.
    await db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, fixture.parentId)).for("update");
      attach = transfers.attachReceipts(replacement(fixture), actor);
      await waitForLockWaiters(1);
      decision = approve(fixture);
      await waitForLockWaiters(2);
    });
    expect(await codeOf(attach!)).toBe("resolved");
    expect(await codeOf(decision!)).toBe("review_manifest_stale");

    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.parentId)))
      .toHaveLength(0);
    const [row] = await db.select().from(issueReviewTransfers).where(eq(issueReviewTransfers.id, fixture.transfer.id));
    expect(row!.receipts).toHaveLength(2);
    expect(row!.manifestRevision).not.toBe(fixture.manifestRevision);
    expect(row!.status).toBe("held");
  });

  it("does not let a binding read before a replacement approve the newer evidence", async () => {
    const fixture = await seed();
    await issueReviewTransferService(db).attachReceipts(replacement(fixture), actor);
    expect(await codeOf(approve(fixture))).toBe("review_manifest_stale");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.parentId)))
      .toHaveLength(0);
  });
});
