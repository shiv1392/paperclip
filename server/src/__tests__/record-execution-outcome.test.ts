import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProcessStartedAt } from "../services/hot-restart.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { errorHandler } from "../middleware/index.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";

// Agent-selected under the bounded repair authorization: real board HTTP API +
// embedded PostgreSQL, with public issue/recovery/activity readback and wake sink.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`Required PostgreSQL test seam unavailable: ${support.reason}`);

describe("board records a historical execution outcome without continuation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-record-execution-outcome-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), authorId = randomUUID(), reviewerId = randomUUID();
    const runId = randomUUID(), reviewerRunId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Outcome Co", issuePrefix: `RO${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: authorId, companyId, name: "Former author", role: "engineer", status: "paused", adapterType: "codex_local" },
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review saved work", status: "in_review", assigneeAgentId: reviewerId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageType: "review", currentStageIndex: 0,
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null }, returnAssignee: { type: "agent", agentId: authorId, userId: null },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0, monitor: null, reviewRequest: null },
    });
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId: authorId, status: "cancelled", errorCode: "agent_paused", startedAt: new Date("2026-10-20T10:00:00Z"), finishedAt: new Date("2026-10-20T10:01:00Z"),
        processPid: 2147483600, processGroupId: 2147483600, processStartedAt: new Date("2026-10-20T10:00:00Z"),
        contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
        resultJson: { cancellation: { reason: "Cancelled due to agent pause", source: "control_plane", expected: true, initiator: { type: "system" }, recordedAt: "2026-10-20T10:01:00Z" } } },
      { id: reviewerRunId, companyId, agentId: reviewerId, status: "cancelled", startedAt: null, contextSnapshot: { issueId } },
    ]);
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: "cancelled", ownerType: "board", returnOwnerAgentId: authorId, cause: "legacy_execution_requires_reconciliation", fingerprint: runId, updatedAt: new Date("2026-10-25T00:00:00Z"),
      nextAction: "Inspect stopped work", evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const [reviewerAction] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", returnOwnerAgentId: reviewerId, cause: "legacy_execution_requires_reconciliation", fingerprint: reviewerRunId,
      nextAction: "Resume pending review", evidence: { runId: reviewerRunId },
    }).returning();
    let wakes = 0;
    const wake = async () => { wakes++; return null; };
    function app(actor: any = { type: "board", source: "local_implicit" }, onRequest?: () => void) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as any).actor = actor; onRequest?.(); next(); });
      app.use("/api", issueRoutes(db, {} as any, { recoveryActionEnqueueWakeup: wake }));
      app.use("/api", activityRoutes(db)); app.use("/api", agentRoutes(db)); app.use(errorHandler); return app;
    }
    const body = { runId, providerStopped: true, actionOutcome: "completed", outcomeEvidence: "The saved commit and review request prove the author completed the recorded edits before cancellation." };
    return { companyId, issueId, authorId, reviewerId, runId, reviewerRunId, action: action!, reviewerAction: reviewerAction!, app, body, wake, wakes: () => wakes,
      path: `/api/issues/${issueId}/recovery-actions/${action!.id}/record-execution-outcome` };
  }

  it("records and reads an immutable receipt while preserving the pending review and newer recovery", async () => {
    const f = await fixture(), app = f.app();
    const authorBefore = (await request(app).get(`/api/agents/${f.authorId}`).expect(200)).body;
    const runBefore = (await request(app).get(`/api/heartbeat-runs/${f.runId}`).expect(200)).body;
    const before = (await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body;
    expect(before.executionBlocker.runId).toBe(f.runId);
    const saved = await request(app).post(f.path).send(f.body).expect(200);
    expect(saved.body.receipt).toMatchObject({ schema: "paperclip.record-execution-outcome.v1", actionId: f.action.id, runId: f.runId,
      actionOutcome: "completed", outcomeEvidence: f.body.outcomeEvidence, continuation: "not_requested" });
    const after = (await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body;
    for (const key of ["status", "assigneeAgentId", "statusVersion", "executionPolicy", "executionState", "checkoutRunId", "executionRunId"]) expect(after[key]).toEqual(before[key]);
    expect((await request(app).get(`/api/agents/${f.authorId}`).expect(200)).body.status).toBe(authorBefore.status);
    const runAfter = (await request(app).get(`/api/heartbeat-runs/${f.runId}`).expect(200)).body;
    for (const key of ["status", "resultJson", "startedAt", "finishedAt", "processPid", "processGroupId", "processStartedAt"]) expect(runAfter[key]).toEqual(runBefore[key]);
    expect(after.activeRecoveryAction).toEqual(before.activeRecoveryAction);
    expect(after.activeRecoveryAction.id).toBe(f.reviewerAction.id);
    expect(after.executionBlocker?.runId).not.toBe(f.runId);
    const list = (await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200)).body;
    const source = list.actions.find((action: any) => action.id === f.action.id);
    expect(source).toMatchObject({ status: f.action.status, outcome: f.action.outcome, nextAction: f.action.nextAction, updatedAt: f.action.updatedAt.toISOString() });
    expect(source.evidence.recordOnlyExecutionOutcome).toEqual(saved.body.receipt);
    expect(saved.body.receipt.sourceRecovery.automaticRecovery).toEqual(f.action.evidence.automaticRecovery);
    const activity = (await request(app).get(`/api/issues/${f.issueId}/activity`).expect(200)).body;
    expect(activity.filter((entry: any) => entry.action === "issue.execution_outcome_recorded")).toHaveLength(1);
    await deliverReconciledExecutions(db, f.wake);
    expect(f.wakes()).toBe(0);
  });
  it("rejects a stale automatic hold whose run receipt no longer matches its source", async () => {
    const f = await fixture();
    await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence,
      automaticRecovery: { ...(f.action.evidence.automaticRecovery as object), runId: f.reviewerRunId },
    } }).where(eq(issueRecoveryActions.id, f.action.id));
    await request(f.app()).post(f.path).send(f.body).expect(409);
    const list = (await request(f.app()).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200)).body;
    expect(list.actions.find((action: any) => action.id === f.action.id).evidence.recordOnlyExecutionOutcome).toBeUndefined();
  });

  async function expectUnchangedHold(f: Awaited<ReturnType<typeof fixture>>) {
    const app = f.app();
    const list = (await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200)).body;
    const source = list.actions.find((action: any) => action.id === f.action.id);
    expect(source.evidence.automaticRecovery.replay).toBe("blocked");
    expect(source.evidence.recordOnlyExecutionOutcome).toBeUndefined();
    const audit = (await request(app).get(`/api/issues/${f.issueId}/activity`).expect(200)).body;
    expect(audit.filter((entry: any) => entry.action === "issue.execution_outcome_recorded")).toHaveLength(0);
    await deliverReconciledExecutions(db, f.wake);
    expect(f.wakes()).toBe(0);
  }

  it("rejects agents, an inaccessible board company, and foreign action/run combinations", async () => {
    const f = await fixture(), other = await fixture();
    for (const agentId of [f.authorId, f.reviewerId]) {
      await request(f.app({ type: "agent", companyId: f.companyId, agentId, runId: f.runId, source: "agent_jwt" }))
        .post(f.path).send(f.body).expect(403);
    }
    await request(f.app({ type: "board", source: "session", userId: "outsider", companyIds: [other.companyId] }))
      .post(f.path).send(f.body).expect(404);
    await request(f.app()).post(f.path.replace(f.action.id, other.action.id)).send(f.body).expect(404);
    await request(f.app()).post(f.path).send({ ...f.body, runId: other.runId }).expect(409);
    await request(f.app()).post(f.path.replace(f.issueId, other.issueId)).send(f.body).expect(404);
    await expectUnchangedHold(f);
  });

  it.each([
    { actionOutcome: "unknown" }, { actionOutcome: "unverified" }, { outcomeEvidence: "" },
    { outcomeEvidence: "short" }, { providerStopped: false }, { sourceIssueStatus: "todo" },
  ])("rejects unsupported decisions without saving a receipt: %j", async invalid => {
    const f = await fixture();
    await request(f.app()).post(f.path).send({ ...f.body, ...invalid }).expect(400);
    await expectUnchangedHold(f);
  });

  it.each(["running", "queued", "succeeded"])("rejects a %s source execution", async status => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  it.each([
    { cause: "uncertain_external_action" }, { status: "active", outcome: null }, { kind: "missing_disposition" },
  ])("rejects an unsupported source recovery: %j", async source => {
    const f = await fixture();
    // The active-action uniqueness constraint requires removing the independent
    // reviewer action only for this deliberately unsupported active fixture.
    if (source.status === "active") await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.reviewerAction.id));
    await db.update(issueRecoveryActions).set(source).where(eq(issueRecoveryActions.id, f.action.id));
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  it.each([
    { processPid: process.pid, processStartedAt: null },
    { processPid: null, processGroupId: null },
    { runnerProfileJson: null },
    { runnerProfileJson: { nativeWorkspaceFinalizationOwner: "unfinished-copyback", adapterDispatch: { adapterType: "codex_local" } } },
  ])("holds live, unknown or unfinished execution ownership: %j", async source => {
    const f = await fixture();
    await db.update(heartbeatRuns).set(source).where(eq(heartbeatRuns.id, f.runId));
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  it.each([
    { status: "active", releasedAt: null, provider: "local" },
    { status: "pending_cleanup", releasedAt: new Date(), provider: "local" },
    { status: "released", releasedAt: new Date(), provider: "local", cleanupStatus: "failed" },
    { status: "released", releasedAt: new Date(), provider: "local", metadata: { pendingCleanupInFlight: true } },
    { status: "released", releasedAt: new Date(), provider: "daytona", cleanupStatus: "success" },
  ])("keeps an unsafe environment lease held: %j", async lease => {
    const f = await fixture();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId, ...lease });
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  it("keeps unfinished coordinator ownership held", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, phase: "terminal_failure", leaseOwner: "other-controller" });
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  it("serializes duplicate requests, returns the original receipt, and rejects changed evidence", async () => {
    const f = await fixture(), app = f.app();
    const results = await Promise.all(Array.from({ length: 3 }, () => request(app).post(f.path).send(f.body).expect(200)));
    expect(new Set(results.map(result => result.body.receipt.id)).size).toBe(1);
    expect(results.filter(result => !result.body.replayed)).toHaveLength(1);
    const replay = await request(app).post(f.path).send(f.body).expect(200);
    expect(replay.body.receipt).toEqual(results[0]!.body.receipt);
    await request(app).post(f.path).send({ ...f.body, outcomeEvidence: "New evidence cannot overwrite the first immutable observed outcome." }).expect(409);
    await request(app).post(f.path).send({ ...f.body, actionOutcome: "not_performed" }).expect(409);
    const audit = (await request(app).get(`/api/issues/${f.issueId}/activity`).expect(200)).body;
    expect(audit.filter((entry: any) => entry.action === "issue.execution_outcome_recorded")).toHaveLength(1);
    const diagnostics = (await request(app).get(`/api/issues/${f.issueId}/diagnostics/wakes`).expect(200)).body;
    expect(diagnostics.wakeRequestCount).toBe(0);
    const runs = (await request(app).get(`/api/issues/${f.issueId}/runs`).expect(200)).body;
    expect(runs.map((run: any) => run.runId).sort()).toEqual([f.runId, f.reviewerRunId].sort());
    await deliverReconciledExecutions(db, f.wake);
    expect(f.wakes()).toBe(0);
  });

  it("rechecks a racing source hold after taking the issue lock", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void, requestEntered!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const incoming = new Promise<void>(resolve => { requestEntered = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      entered(); await held;
      await tx.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, runId: f.reviewerRunId } }).where(eq(issueRecoveryActions.id, f.action.id));
    });
    await locked;
    const pending = request(f.app(undefined, requestEntered)).post(f.path).send(f.body).then(result => result);
    try { await incoming; } finally { release(); }
    await writer;
    expect((await pending).status).toBe(409);
    await expectUnchangedHold(f);
  });

  it("still denies continuation of the old author before and after record-only reconciliation", async () => {
    const f = await fixture(), app = f.app();
    const continuation = { actionId: f.action.id, outcome: "restored", sourceIssueStatus: "in_review", executionReconciliation: f.body };
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(continuation).expect(409);
    await request(app).post(f.path).send({ ...f.body, actionOutcome: "not_performed" }).expect(200);
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(continuation).expect(409);
    const after = (await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body;
    expect(after.assigneeAgentId).toBe(f.reviewerId);
    expect(after.status).toBe("in_review");
    await deliverReconciledExecutions(db, f.wake);
    expect(f.wakes()).toBe(0);
  });

  it("rejects a foreign source run even if evidence and request agree", async () => {
    const f = await fixture(), other = await fixture();
    await db.update(issueRecoveryActions).set({ evidence: { ...f.action.evidence, runId: other.runId,
      automaticRecovery: { ...(f.action.evidence.automaticRecovery as object), runId: other.runId },
    } }).where(eq(issueRecoveryActions.id, f.action.id));
    await request(f.app()).post(f.path).send({ ...f.body, runId: other.runId }).expect(409);
    await expectUnchangedHold(f);
  });

  it("retains a lease created while the request waits on the issue lock", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void, requestEntered!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const incoming = new Promise<void>(resolve => { requestEntered = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      entered(); await held;
      await tx.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId, status: "active", provider: "local" });
    });
    await locked;
    const pending = request(f.app(undefined, requestEntered)).post(f.path).send(f.body).then(result => result);
    try { await incoming; } finally { release(); }
    await writer;
    expect((await pending).status).toBe(409);
    await expectUnchangedHold(f);
  });

  it("holds a live provider with its matching process birth", async () => {
    const f = await fixture(), birth = await readProcessStartedAt(process.pid);
    expect(birth).not.toBeNull();
    await db.update(heartbeatRuns).set({ processPid: process.pid, processStartedAt: new Date(birth!) }).where(eq(heartbeatRuns.id, f.runId));
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  // Owned fixture processes finish on their own. No signal or lease repair is
  // used to manufacture stop proof. stdout closes only after all group members exit.
  it.skipIf(process.platform === "win32").each(["singleton", "additional member", "leaderless", "unknown snapshot"] as const)(
    "uses conservative PID-reuse proof for a real %s group", async scenario => {
      const f = await fixture();
      const nested = scenario === "additional member" || scenario === "leaderless";
      const script = nested
        ? `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),4000)'],{stdio:['ignore',1,2]}); console.log(child.pid); ${scenario === "leaderless" ? "process.exit(0)" : "setTimeout(()=>process.exit(0),4000)"}`
        : "console.log(process.pid); setTimeout(()=>process.exit(0),4000)";
      const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exit = once(child, "exit");
      const closed = once(child.stdout!, "close");
      let faultDir: string | undefined;
      const previousPath = process.env.PATH;
      try {
        await once(child.stdout!, "data");
        if (scenario === "leaderless") await exit;
        await db.update(heartbeatRuns).set({ processPid: child.pid!, processGroupId: child.pid!, processStartedAt: new Date("1970-01-01T00:00:00Z") })
          .where(eq(heartbeatRuns.id, f.runId));
        if (scenario === "unknown snapshot") {
          faultDir = await mkdtemp(path.join(os.tmpdir(), "record-outcome-ps-"));
          await writeFile(path.join(faultDir, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
          process.env.PATH = faultDir; // Scoped OS-command fault, never host configuration.
        }
        await request(f.app()).post(f.path).send(f.body).expect(scenario === "singleton" ? 200 : 409);
        if (scenario !== "singleton") await expectUnchangedHold(f);
        else { await deliverReconciledExecutions(db, f.wake); expect(f.wakes()).toBe(0); }
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        await exit; await closed;
        if (faultDir) await rm(faultDir, { recursive: true, force: true });
      }
    });

  it("keeps an unexpired legacy controller lease held", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await request(f.app()).post(f.path).send(f.body).expect(409);
    await expectUnchangedHold(f);
  });

  it("never delivers a record-only receipt even if stale continuation bookkeeping appears later", async () => {
    const f = await fixture(), app = f.app();
    await request(app).post(f.path).send(f.body).expect(200);
    const list = (await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200)).body;
    const source = list.actions.find((action: any) => action.id === f.action.id);
    // Controlled stale-writer fixture: the durable record-only receipt must
    // remain authoritative even if old continuation fields are reintroduced.
    await db.update(issueRecoveryActions).set({ evidence: { ...source.evidence,
      executionReconciliation: f.body, continuationDelivery: "pending",
    } }).where(eq(issueRecoveryActions.id, f.action.id));
    await db.update(issues).set({ assigneeAgentId: f.authorId }).where(eq(issues.id, f.issueId));
    await deliverReconciledExecutions(db, f.wake);
    expect(f.wakes()).toBe(0);
  });

  it("accepts the immutable adapter invocation when an old run has no adapter claim", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ runnerProfileJson: null }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId: f.authorId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: "claude_local" } });
    // Current agent configuration is deliberately different from the old claim.
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, f.authorId));
    const result = await request(f.app()).post(f.path).send(f.body).expect(200);
    expect(result.body.receipt.runId).toBe(f.runId);
    await deliverReconciledExecutions(db, f.wake);
    expect(f.wakes()).toBe(0);
  });

});
