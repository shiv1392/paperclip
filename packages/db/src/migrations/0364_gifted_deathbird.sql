ALTER TABLE "issue_execution_decisions" ADD COLUMN "review_manifest_binding" jsonb;--> statement-breakpoint
ALTER TABLE "issue_review_transfers" ADD COLUMN "manifest_revision" text;