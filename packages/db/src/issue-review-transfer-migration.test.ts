import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { issueReviewTransfers } from "./schema/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

function uniqueIndexColumns(name: string) {
  const index = getTableConfig(issueReviewTransfers).indexes.find((candidate) => candidate.config.name === name);
  expect(index?.config.unique).toBe(true);
  return index?.config.columns.map((column) => (column as { name: string }).name);
}

describe("issue review transfer schema", () => {
  it("lets each source review stage be transferred at most once per company", () => {
    expect(uniqueIndexColumns("issue_review_transfers_source_stage_uq")).toEqual([
      "company_id",
      "source_issue_id",
      "source_stage_id",
    ]);
  });

  it("deduplicates transport replays by company idempotency key", () => {
    expect(uniqueIndexColumns("issue_review_transfers_idempotency_uq")).toEqual(["company_id", "idempotency_key"]);
  });

  it("maps each transferred obligation to its own destination stage", () => {
    expect(uniqueIndexColumns("issue_review_transfers_destination_stage_uq")).toEqual([
      "company_id",
      "destination_issue_id",
      "destination_stage_id",
    ]);
  });

  it("ships one additive migration that leaves issue_relations untouched", async () => {
    const files = await fs.readdir(migrationsDir);
    const creating = [];
    for (const file of files.filter((name) => name.endsWith(".sql"))) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      if (sql.includes('CREATE TABLE "issue_review_transfers"')) creating.push(sql);
    }
    expect(creating).toHaveLength(1);
    expect(creating[0]).not.toMatch(/issue_relations/);
    expect(creating[0]).not.toMatch(/DROP|ALTER TABLE "issues"/);
  });
});

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("review manifest binding migration", () => {
  it("adds both columns as nullable, without a default or backfill", async () => {
    const files = await fs.readdir(migrationsDir);
    const adding = [];
    for (const file of files.filter((name) => name.endsWith(".sql"))) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      if (sql.includes('"review_manifest_binding"')) adding.push(sql);
    }
    expect(adding).toHaveLength(1);
    expect(adding[0]).toMatch(/ALTER TABLE "issue_execution_decisions" ADD COLUMN "review_manifest_binding" jsonb;/);
    expect(adding[0]).toMatch(/ALTER TABLE "issue_review_transfers" ADD COLUMN "manifest_revision" text;/);
    expect(adding[0]).not.toMatch(/NOT NULL|DEFAULT|UPDATE |DROP/);
  });
});

describeEmbeddedPostgres("review manifest binding schema", () => {
  it("keeps legacy decision rows unbound and stores a binding on new ones", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("paperclip-review-manifest-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const columns = await sql`
      SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns
      WHERE (table_name = 'issue_execution_decisions' AND column_name = 'review_manifest_binding')
         OR (table_name = 'issue_review_transfers' AND column_name = 'manifest_revision')
      ORDER BY table_name`;
    expect(columns.map((column) => [column.table_name, column.is_nullable, column.data_type])).toEqual([
      ["issue_execution_decisions", "YES", "jsonb"],
      ["issue_review_transfers", "YES", "text"],
    ]);

    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Legacy', 'LGC') RETURNING id`;
    const [issue] = await sql`INSERT INTO issues (company_id, title) VALUES (${company!.id}, 'Legacy issue') RETURNING id`;
    // A decision written the way pre-migration code did, naming no binding.
    await sql`INSERT INTO issue_execution_decisions (company_id, issue_id, stage_id, stage_type, outcome, body)
      VALUES (${company!.id}, ${issue!.id}, gen_random_uuid(), 'review', 'approved', 'Legacy approval')`;
    const binding = { destinationIssueId: issue!.id, revision: "r1", finalHead: "h", finalTree: "t", transfers: [] };
    await sql`INSERT INTO issue_execution_decisions (company_id, issue_id, stage_id, stage_type, outcome, body, review_manifest_binding)
      VALUES (${company!.id}, ${issue!.id}, gen_random_uuid(), 'review', 'approved', 'Bound approval', ${sql.json(binding)})`;
    const rows = await sql`SELECT body, review_manifest_binding FROM issue_execution_decisions ORDER BY body DESC`;
    expect(rows.map((row) => [row.body, row.review_manifest_binding])).toEqual([
      ["Legacy approval", null],
      ["Bound approval", binding],
    ]);
  });
});
