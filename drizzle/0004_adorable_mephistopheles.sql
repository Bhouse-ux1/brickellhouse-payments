CREATE TABLE "terminal_reader_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" varchar(255) NOT NULL,
	"reader_id" varchar(255) NOT NULL,
	"location_id" varchar(255) NOT NULL,
	"live_mode" boolean NOT NULL,
	"action_type" varchar(80) NOT NULL,
	"action_status" varchar(40) NOT NULL,
	"stripe_payment_intent_id" varchar(255) NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_reader_observations_stripe_event_id_unique" UNIQUE("stripe_event_id"),
	CONSTRAINT "terminal_reader_observations_action_type" CHECK ("terminal_reader_observations"."action_type" = 'process_payment_intent'),
	CONSTRAINT "terminal_reader_observations_action_status" CHECK ("terminal_reader_observations"."action_status" IN ('in_progress', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "terminal_reader_observations" ADD CONSTRAINT "terminal_reader_observations_stripe_event_id_stripe_events_stripe_event_id_fk" FOREIGN KEY ("stripe_event_id") REFERENCES "public"."stripe_events"("stripe_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_reader_observations" ADD CONSTRAINT "terminal_reader_observations_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_reader_observations" ADD CONSTRAINT "terminal_reader_observations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_reader_observations_intent_status_idx" ON "terminal_reader_observations" USING btree ("stripe_payment_intent_id","action_status");--> statement-breakpoint
CREATE INDEX "terminal_reader_observations_attempt_idx" ON "terminal_reader_observations" USING btree ("payment_attempt_id");