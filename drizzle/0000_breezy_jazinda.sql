CREATE TYPE "public"."payment_attempt_status" AS ENUM('CREATED', 'READER_RESERVED', 'PAYMENT_INTENT_CREATED', 'SENT_TO_READER', 'WAITING_FOR_CUSTOMER', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."email_delivery_kind" AS ENUM('RESIDENT_RECEIPT');--> statement-breakpoint
CREATE TYPE "public"."email_delivery_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('STRIPE_TERMINAL');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('DRAFT', 'READY', 'SENDING_TO_TERMINAL', 'WAITING_FOR_CUSTOMER', 'PROCESSING', 'PAID', 'FAILED', 'CANCELED', 'TERMINAL_BUSY', 'TERMINAL_OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'MANAGER', 'EMPLOYEE', 'ACCOUNTING');--> statement-breakpoint
CREATE SEQUENCE "public"."pos_transaction_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"action" varchar(120) NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"safe_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" "email_delivery_kind" DEFAULT 'RESIDENT_RECEIPT' NOT NULL,
	"recipient_email" varchar(320) NOT NULL,
	"status" "email_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"provider_message_id" varchar(255),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "email_deliveries_attempt_nonnegative" CHECK ("email_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'CREATED' NOT NULL,
	"expected_amount_cents" integer NOT NULL,
	"terminal_reader_id" uuid,
	"stripe_payment_intent_id" varchar(255),
	"stripe_reader_operation_id" varchar(255),
	"last_error_code" varchar(100),
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payment_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_attempts_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "payment_attempts_stripe_reader_operation_id_unique" UNIQUE("stripe_reader_operation_id"),
	CONSTRAINT "payment_attempts_number_positive" CHECK ("payment_attempts"."attempt_number" > 0),
	CONSTRAINT "payment_attempts_amount_nonnegative" CHECK ("payment_attempts"."expected_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"price_cents" integer NOT NULL,
	"gl_code" varchar(20) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"terminal_enabled" boolean DEFAULT true NOT NULL,
	"quantity_allowed" boolean DEFAULT true NOT NULL,
	"category" varchar(40) DEFAULT 'Other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_nonnegative" CHECK ("products"."price_cents" >= 0),
	CONSTRAINT "products_gl_trusted" CHECK (("products"."id" = 'valet_parking' AND "products"."gl_code" = '40033') OR ("products"."id" <> 'valet_parking' AND "products"."gl_code" = '40090'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" varchar(255) NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"live_mode" boolean NOT NULL,
	"payload_sha256" varchar(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	CONSTRAINT "stripe_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "terminal_readers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(100) NOT NULL,
	"stripe_reader_id" varchar(255) NOT NULL,
	"stripe_location_id" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"lock_payment_attempt_id" uuid,
	"lock_acquired_at" timestamp with time zone,
	"lock_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_readers_stripe_reader_id_unique" UNIQUE("stripe_reader_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"product_id" varchar(64),
	"product_name_snapshot" varchar(160) NOT NULL,
	"unit_price_cents_snapshot" integer NOT NULL,
	"quantity" integer NOT NULL,
	"gl_code_snapshot" varchar(20) NOT NULL,
	"line_total_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_items_quantity_positive" CHECK ("transaction_items"."quantity" > 0),
	CONSTRAINT "transaction_items_money_nonnegative" CHECK ("transaction_items"."unit_price_cents_snapshot" >= 0 AND "transaction_items"."line_total_cents" >= 0),
	CONSTRAINT "transaction_items_line_total_consistent" CHECK ("transaction_items"."line_total_cents" = "transaction_items"."unit_price_cents_snapshot" * "transaction_items"."quantity"),
	CONSTRAINT "transaction_items_gl_trusted" CHECK (("transaction_items"."product_id" = 'valet_parking' AND "transaction_items"."gl_code_snapshot" = '40033') OR (("transaction_items"."product_id" IS NULL OR "transaction_items"."product_id" <> 'valet_parking') AND "transaction_items"."gl_code_snapshot" = '40090'))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_sequence" bigint NOT NULL,
	"number" varchar(32) NOT NULL,
	"unit_number" varchar(30) NOT NULL,
	"customer_email" varchar(320) NOT NULL,
	"employee_id" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"processing_fee_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"payment_status" "payment_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_method" "payment_method",
	"paid_at" timestamp with time zone,
	"stripe_payment_intent_id" varchar(255),
	"stripe_charge_id" varchar(255),
	"stripe_reader_id" varchar(255),
	"stripe_location_id" varchar(255),
	"card_brand" varchar(40),
	"card_last_four" varchar(4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_number_sequence_unique" UNIQUE("number_sequence"),
	CONSTRAINT "transactions_number_unique" UNIQUE("number"),
	CONSTRAINT "transactions_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "transactions_stripe_charge_id_unique" UNIQUE("stripe_charge_id"),
	CONSTRAINT "transactions_money_nonnegative" CHECK ("transactions"."subtotal_cents" >= 0 AND "transactions"."processing_fee_cents" >= 0 AND "transactions"."total_cents" >= 0),
	CONSTRAINT "transactions_total_consistent" CHECK ("transactions"."total_cents" = "transactions"."subtotal_cents" + "transactions"."processing_fee_cents"),
	CONSTRAINT "transactions_last_four_safe" CHECK ("transactions"."card_last_four" IS NULL OR "transactions"."card_last_four" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" "user_role" DEFAULT 'EMPLOYEE' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_terminal_reader_id_terminal_readers_id_fk" FOREIGN KEY ("terminal_reader_id") REFERENCES "public"."terminal_readers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_uidx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_receipt_once_uidx" ON "email_deliveries" USING btree ("transaction_id","kind");--> statement-breakpoint
CREATE INDEX "email_deliveries_status_idx" ON "email_deliveries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_transaction_attempt_uidx" ON "payment_attempts" USING btree ("transaction_id","attempt_number");--> statement-breakpoint
CREATE INDEX "payment_attempts_transaction_idx" ON "payment_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_events_type_received_idx" ON "stripe_events" USING btree ("event_type","received_at");--> statement-breakpoint
CREATE INDEX "terminal_readers_location_idx" ON "terminal_readers" USING btree ("stripe_location_id");--> statement-breakpoint
CREATE INDEX "transaction_items_transaction_idx" ON "transaction_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_items_gl_idx" ON "transaction_items" USING btree ("gl_code_snapshot");--> statement-breakpoint
CREATE INDEX "transactions_created_at_idx" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "transactions_unit_idx" ON "transactions" USING btree ("unit_number");--> statement-breakpoint
CREATE INDEX "transactions_status_created_idx" ON "transactions" USING btree ("payment_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verifications_identifier_value_uidx" ON "verifications" USING btree ("identifier","value");