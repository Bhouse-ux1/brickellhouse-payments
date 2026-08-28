ALTER TYPE "public"."user_role" ADD VALUE 'STAFF' BEFORE 'MANAGER';--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "delivery_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_version_positive" CHECK ("email_deliveries"."delivery_version" > 0);
