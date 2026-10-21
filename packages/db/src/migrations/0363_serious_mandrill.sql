CREATE TABLE "issue_review_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_stage_id" uuid NOT NULL,
	"destination_issue_id" uuid NOT NULL,
	"destination_stage_id" uuid NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"reason" text NOT NULL,
	"obligation" jsonb NOT NULL,
	"removed_blocker_issue_id" uuid,
	"removed_blocked_issue_id" uuid,
	"receipts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_revision" text,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_review_transfers" ADD CONSTRAINT "issue_review_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_transfers" ADD CONSTRAINT "issue_review_transfers_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_transfers" ADD CONSTRAINT "issue_review_transfers_destination_issue_id_issues_id_fk" FOREIGN KEY ("destination_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_transfers" ADD CONSTRAINT "issue_review_transfers_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_transfers" ADD CONSTRAINT "issue_review_transfers_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_review_transfers_source_stage_uq" ON "issue_review_transfers" USING btree ("company_id","source_issue_id","source_stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_review_transfers_idempotency_uq" ON "issue_review_transfers" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_review_transfers_destination_stage_uq" ON "issue_review_transfers" USING btree ("company_id","destination_issue_id","destination_stage_id");--> statement-breakpoint
CREATE INDEX "issue_review_transfers_company_source_idx" ON "issue_review_transfers" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "issue_review_transfers_company_destination_idx" ON "issue_review_transfers" USING btree ("company_id","destination_issue_id");