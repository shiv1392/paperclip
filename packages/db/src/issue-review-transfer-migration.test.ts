import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueReviewTransfers } from "./schema/index.js";

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
