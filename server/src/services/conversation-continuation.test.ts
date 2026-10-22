import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readProcessStartedAt } from "./hot-restart.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { deliverExecutionStatuses } from "./execution-status-delivery.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping execution identity regressions: ${support.reason}`);

describePostgres("execution identity query contracts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("execution-identity-"); db = createDb(database.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
    await db.insert(issues).values([{ id: issueId, companyId, title: "Target" }, { id: otherIssueId, companyId, title: "Other" }]);
    return { companyId, agentId, issueId, otherIssueId };
  }
  async function run(f: Awaited<ReturnType<typeof fixture>>, context: Record<string, unknown> | null, nativeIssueId: string | null = null, pid: number | null = null) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId,
      status: "interrupted", runtimeMode: "legacy", contextSnapshot: context, processPid: pid,
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }).returning();
    return row;
  }
  // Agent-selected public seam under delegated bounded-validation authority:
  // real ownership service, persisted run evidence, and owned OS processes.
  async function ownedGroup(withMember = false, executable = process.execPath) {
    const child = spawn(executable, ["-e", `
      const { spawn } = require("node:child_process");
      setInterval(() => {}, 1000);
      if (${withMember}) {
        const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.send({ ready: true });"],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        member.once("message", () => process.send({ ready: true, memberPid: member.pid }));
        process.on("message", async () => {
          const exited = new Promise(resolve => member.once("exit", resolve));
          member.kill("SIGTERM");
          await exited;
          process.exit(0);
        });
      } else process.send({ ready: true });
    `], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5_000) }) as [{ memberPid?: number }];
      const startedAt = new Date((await readProcessStartedAt(child.pid!))!);
      return { pid: child.pid!, memberPid: ready.memberPid, startedAt,
        async stopLeader() {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await exited;
        },
        async cleanup() {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            if (withMember) child.send({ stop: true });
            else child.kill("SIGTERM");
            await exited;
          } else if (ready.memberPid) {
            // This PID was spawned by our fixture, never discovered from the host.
            process.kill(ready.memberPid, "SIGTERM");
            await expect.poll(() => {
              try { process.kill(ready.memberPid!, 0); return false; }
              catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
            }).toBe(true);
          }
        },
      };
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        // A detached fixture owns its whole group, including a child whose
        // readiness handshake failed. Never apply this to observed host groups.
        process.kill(-child.pid, "SIGTERM");
        await exited;
        await expect.poll(() => {
          try { process.kill(-child.pid!, 0); return false; }
          catch (probeError) { return (probeError as NodeJS.ErrnoException).code === "ESRCH"; }
        }).toBe(true);
      }
      throw error;
    }
  }
  // Linux identity reads bypass ps. Fault only this owned PID's OS stat read,
  // and update native ESM bindings so the real Linux reader sees the boundary.
  function denyLinuxIdentityRead(pid: number, successfulReads = 0) {
    const realRead = nodeFs.readFileSync;
    let reads = 0;
    const fault = vi.spyOn(nodeFs, "readFileSync").mockImplementation(((...args: Parameters<typeof realRead>) => {
      if (args[0] === `/proc/${pid}/stat` && reads++ >= successfulReads) {
        throw Object.assign(new Error("Fixture process identity unavailable"), { code: "EACCES" });
      }
      return Reflect.apply(realRead, nodeFs, args);
    }) as typeof realRead);
    syncBuiltinESMExports();
    return () => { fault.mockRestore(); syncBuiltinESMExports(); };
  }
  it.skipIf(process.platform === "win32")("faults the Linux identity adapter at the owned PID stat boundary", async () => {
    const group = await ownedGroup();
    const restore = denyLinuxIdentityRead(group.pid);
    try {
      await expect(readProcessStartedAt(group.pid, { platform: "linux" })).rejects.toMatchObject({ code: "EACCES" });
    } finally { restore(); await group.cleanup(); }
  });
  it.skipIf(process.platform === "win32")("releases a reused process-group leader when it is the sole group member", async () => {
    const group = await ownedGroup();
    try {
      const f = await fixture();
      const row = await run(f, { issueId: f.issueId }, null, group.pid);
      await db.update(heartbeatRuns).set({ processGroupId: group.pid,
        processStartedAt: new Date(group.startedAt.getTime() - 60_000) }).where(eq(heartbeatRuns.id, row.id));
      expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
    } finally { await group.cleanup(); }
  });
  it.skipIf(process.platform === "win32").each(["matching birth", "missing birth", "unreadable identity", "unreadable membership", "identity lost after snapshot", "lease", "additional member", "separate group", "failed second start", "leaderless group"] as const)(
    "preserves ownership checks and fixture cleanup with %s", async scenario => {
      const group = await ownedGroup(scenario === "additional member" || scenario === "leaderless group");
      let separate: Awaited<ReturnType<typeof ownedGroup>> | null = null;
      const previousPath = process.env.PATH;
      let faultDir: string | undefined;
      let restoreIdentityRead: (() => void) | undefined;
      try {
        if (scenario === "failed second start") {
          // A missing executable faults the real spawn boundary before any
          // second process exists. The first group is already cleanup-owned.
          await expect(ownedGroup(false, path.join(tmpdir(), randomUUID(), "missing-node")))
            .rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        if (scenario === "separate group") separate = await ownedGroup();
        const f = await fixture();
        const row = await run(f, { issueId: f.issueId }, null, group.pid);
        await db.update(heartbeatRuns).set({ processGroupId: separate?.pid ?? group.pid,
          processStartedAt: scenario === "missing birth" ? null : scenario === "matching birth"
            ? group.startedAt : new Date(group.startedAt.getTime() - 60_000) }).where(eq(heartbeatRuns.id, row.id));
        if (scenario === "lease") await db.insert(environmentLeases).values({
          companyId: f.companyId, heartbeatRunId: row.id, provider: "local", status: "active",
        });
        if (scenario === "leaderless group") await group.stopLeader();
        if (process.platform === "linux" && (scenario === "unreadable identity" || scenario === "identity lost after snapshot")) {
          restoreIdentityRead = denyLinuxIdentityRead(group.pid, scenario === "identity lost after snapshot" ? 1 : 0);
        } else if (scenario === "unreadable identity" || scenario === "unreadable membership" || scenario === "identity lost after snapshot") {
          faultDir = await mkdtemp(path.join(tmpdir(), "ownership-ps-"));
          // Fault the OS-command boundary only; the ownership service is real.
          await writeFile(path.join(faultDir, "ps"), scenario === "unreadable identity"
            ? "#!/bin/sh\nexit 1\n"
            : scenario === "unreadable membership"
              ? '#!/bin/sh\nif [ "$1" = "-A" ]; then exit 1; fi\nexec /bin/ps "$@"\n'
              : '#!/bin/sh\nif [ "$1" != "-A" ]; then\n  marker="${0%/*}/seen"\n  if [ -e "$marker" ]; then exit 1; fi\n  : > "$marker"\nfi\nexec /bin/ps "$@"\n', { mode: 0o700 });
          process.env.PATH = faultDir;
        }
        expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({
          runId: row.id, cause: "execution_owner_active",
        });
      } finally {
        restoreIdentityRead?.();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await group.cleanup();
        if (scenario === "failed second start") expect(() => process.kill(group.pid, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }));
        await separate?.cleanup();
        if (faultDir) await rm(faultDir, { recursive: true, force: true });
      }
    });
  it("matches only canonical evidence IDs and keeps source issue and company scope", async () => {
    const f = await fixture(), foreign = await fixture();
    const ours = await run(f, { issueId: f.issueId });
    const elsewhere = await run(f, { issueId: f.otherIssueId });
    const foreignRun = await run(foreign, { issueId: f.issueId });
    const ids: unknown[] = [ours.id, ours.id.toUpperCase(), ours.id.replaceAll("-", ""), `{${ours.id}}`, "bad", "", null, 42, {}, [ours.id], elsewhere.id, foreignRun.id];
    const actions = await db.insert(issueRecoveryActions).values(ids.map((runId, index) => ({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `fixture-${index}`, evidence: { runId }, nextAction: "Fixture",
    }))).returning();
    const matches = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, f.companyId), conversationRecoveryActionPredicate()));
    expect(matches).toEqual([{ id: actions[0].id }]);
  });
  it("preserves native issue precedence and does not broaden legacy spellings", async () => {
    const f = await fixture();
    await run(f, { issueId: f.issueId }, f.otherIssueId, process.pid);
    const uppercase = await run(f, { issueId: f.issueId.toUpperCase() }, null, process.pid);
    const malformed = await run(f, { issueId: "bad" }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
    const native = await run(f, { issueId: f.otherIssueId }, f.issueId, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: native.id, cause: "execution_owner_active" });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId.toUpperCase())).toMatchObject({ runId: uppercase.id });
    expect(await getConversationOwnershipBlocker(db, f.companyId, "bad")).toMatchObject({ runId: malformed.id });
  });
  it("retains legacy ownership holds and releases only after ownership ends", async () => {
    const f = await fixture();
    const legacy = await run(f, { issueId: f.issueId }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: legacy.id });
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, legacy.id));
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
  it("delivers canonical same-company task IDs and keeps malformed IDs private", async () => {
    const f = await fixture(), foreign = await fixture();
    const contexts: unknown[] = [f.issueId, f.issueId.toUpperCase(), "bad", `{${f.issueId}}`, f.issueId.replaceAll("-", ""), null, 42, {}, [f.issueId], foreign.issueId];
    const expected = new Map<string, string | null>();
    for (const [index, issueId] of contexts.entries()) {
      const row = await run(f, { issueId });
      await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, row.id));
      expected.set(row.id, index === 0 ? f.issueId : null);
    }
    const native = await run(f, { issueId: f.otherIssueId }, f.issueId);
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, native.id));
    expected.set(native.id, f.issueId);
    const seen = new Map<string, string | null>();
    const result = await deliverExecutionStatuses(db, { publish: event => { seen.set(event.payload!.runId as string, event.payload!.issueId as string | null); return { ...event, id: 0, payload: event.payload ?? {}, createdAt: new Date().toISOString() }; } });
    expect(result.delivered).toBe(expected.size);
    expect(seen).toEqual(expected);
    expect(await deliverExecutionStatuses(db, { publish: () => { throw new Error("duplicate delivery"); } })).toEqual({ scanned: 0, delivered: 0 });
  });
});
