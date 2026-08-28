import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["ADMIN", "STAFF", "MANAGER", "EMPLOYEE", "ACCOUNTING"]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "DRAFT", "READY", "SENDING_TO_TERMINAL", "WAITING_FOR_CUSTOMER", "PROCESSING",
  "PAID", "FAILED", "CANCELED", "TERMINAL_BUSY", "TERMINAL_OFFLINE",
]);
export const paymentMethodEnum = pgEnum("payment_method", ["STRIPE_TERMINAL"]);
export const attemptStatusEnum = pgEnum("payment_attempt_status", [
  "CREATED", "READER_RESERVED", "PAYMENT_INTENT_CREATED", "SENT_TO_READER",
  "WAITING_FOR_CUSTOMER", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELED", "EXPIRED",
]);
export const emailStatusEnum = pgEnum("email_delivery_status", ["PENDING", "SENDING", "SENT", "FAILED"]);
export const emailKindEnum = pgEnum("email_delivery_kind", ["RESIDENT_RECEIPT"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Keep the legacy database default fail-closed. Better Auth/admin creation
  // always supplies the approved ADMIN or STAFF role explicitly.
  role: userRoleEnum("role").notNull().default("EMPLOYEE"),
  active: boolean("active").notNull().default(true),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sessions_user_id_idx").on(table.userId)]);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("accounts_issuer_account_uidx").on(table.issuer, table.accountId),
  uniqueIndex("accounts_provider_account_uidx").on(table.providerId, table.accountId),
  index("accounts_user_id_idx").on(table.userId),
]);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("verifications_identifier_idx").on(table.identifier),
  uniqueIndex("verifications_identifier_value_uidx").on(table.identifier, table.value),
]);

export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const products = pgTable("products", {
  id: varchar("id", { length: 64 }).primaryKey(),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  priceCents: integer("price_cents").notNull(),
  glCode: varchar("gl_code", { length: 20 }).notNull(),
  active: boolean("active").notNull().default(true),
  terminalEnabled: boolean("terminal_enabled").notNull().default(true),
  quantityAllowed: boolean("quantity_allowed").notNull().default(true),
  category: varchar("category", { length: 40 }).notNull().default("Other"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("products_price_nonnegative", sql`${table.priceCents} >= 0`),
  check("products_gl_trusted", sql`(${table.id} = 'valet_parking' AND ${table.glCode} = '40033') OR (${table.id} <> 'valet_parking' AND ${table.glCode} = '40090')`),
]);

export const transactionNumberSequence = pgSequence("pos_transaction_number_seq", { startWith: 1 });

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  numberSequence: bigint("number_sequence", { mode: "number" }).notNull().unique(),
  number: varchar("number", { length: 32 }).notNull().unique(),
  unitNumber: varchar("unit_number", { length: 30 }).notNull(),
  customerEmail: varchar("customer_email", { length: 320 }).notNull(),
  employeeId: text("employee_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  subtotalCents: integer("subtotal_cents").notNull(),
  processingFeeCents: integer("processing_fee_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("DRAFT"),
  paymentMethod: paymentMethodEnum("payment_method"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }).unique(),
  stripeChargeId: varchar("stripe_charge_id", { length: 255 }).unique(),
  stripeReaderId: varchar("stripe_reader_id", { length: 255 }),
  stripeLocationId: varchar("stripe_location_id", { length: 255 }),
  cardBrand: varchar("card_brand", { length: 40 }),
  cardLastFour: varchar("card_last_four", { length: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("transactions_created_at_idx").on(table.createdAt),
  index("transactions_unit_idx").on(table.unitNumber),
  index("transactions_status_created_idx").on(table.paymentStatus, table.createdAt),
  check("transactions_money_nonnegative", sql`${table.subtotalCents} >= 0 AND ${table.processingFeeCents} >= 0 AND ${table.totalCents} >= 0`),
  check("transactions_total_consistent", sql`${table.totalCents} = ${table.subtotalCents} + ${table.processingFeeCents}`),
  check("transactions_last_four_safe", sql`${table.cardLastFour} IS NULL OR ${table.cardLastFour} ~ '^[0-9]{4}$'`),
]);

export const transactionItems = pgTable("transaction_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "restrict" }),
  productId: varchar("product_id", { length: 64 }),
  productNameSnapshot: varchar("product_name_snapshot", { length: 160 }).notNull(),
  unitPriceCentsSnapshot: integer("unit_price_cents_snapshot").notNull(),
  quantity: integer("quantity").notNull(),
  glCodeSnapshot: varchar("gl_code_snapshot", { length: 20 }).notNull(),
  lineTotalCents: integer("line_total_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("transaction_items_transaction_idx").on(table.transactionId),
  index("transaction_items_gl_idx").on(table.glCodeSnapshot),
  check("transaction_items_quantity_positive", sql`${table.quantity} > 0`),
  check("transaction_items_money_nonnegative", sql`${table.unitPriceCentsSnapshot} >= 0 AND ${table.lineTotalCents} >= 0`),
  check("transaction_items_line_total_consistent", sql`${table.lineTotalCents} = ${table.unitPriceCentsSnapshot} * ${table.quantity}`),
  check("transaction_items_gl_trusted", sql`(${table.productId} = 'valet_parking' AND ${table.glCodeSnapshot} = '40033') OR ((${table.productId} IS NULL OR ${table.productId} <> 'valet_parking') AND ${table.glCodeSnapshot} = '40090')`),
]);

export const terminalReaders = pgTable("terminal_readers", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: varchar("label", { length: 100 }).notNull(),
  stripeReaderId: varchar("stripe_reader_id", { length: 255 }).notNull().unique(),
  stripeLocationId: varchar("stripe_location_id", { length: 255 }).notNull(),
  active: boolean("active").notNull().default(true),
  lockPaymentAttemptId: uuid("lock_payment_attempt_id"),
  lockAcquiredAt: timestamp("lock_acquired_at", { withTimezone: true }),
  lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("terminal_readers_location_idx").on(table.stripeLocationId)]);

export const paymentAttempts = pgTable("payment_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull().unique(),
  status: attemptStatusEnum("status").notNull().default("CREATED"),
  expectedAmountCents: integer("expected_amount_cents").notNull(),
  terminalReaderId: uuid("terminal_reader_id").references(() => terminalReaders.id, { onDelete: "restrict" }),
  stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }).unique(),
  stripeReaderOperationId: varchar("stripe_reader_operation_id", { length: 255 }).unique(),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: text("last_error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("payment_attempts_transaction_attempt_uidx").on(table.transactionId, table.attemptNumber),
  index("payment_attempts_transaction_idx").on(table.transactionId),
  index("payment_attempts_status_idx").on(table.status),
  check("payment_attempts_number_positive", sql`${table.attemptNumber} > 0`),
  check("payment_attempts_amount_nonnegative", sql`${table.expectedAmountCents} >= 0`),
]);

export const stripeEvents = pgTable("stripe_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  stripeEventId: varchar("stripe_event_id", { length: 255 }).notNull().unique(),
  eventType: varchar("event_type", { length: 120 }).notNull(),
  liveMode: boolean("live_mode").notNull(),
  payloadSha256: varchar("payload_sha256", { length: 64 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingError: text("processing_error"),
}, (table) => [index("stripe_events_type_received_idx").on(table.eventType, table.receivedAt)]);

export const emailDeliveries = pgTable("email_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "restrict" }),
  kind: emailKindEnum("kind").notNull().default("RESIDENT_RECEIPT"),
  recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
  status: emailStatusEnum("status").notNull().default("PENDING"),
  providerMessageId: varchar("provider_message_id", { length: 255 }).unique(),
  attemptCount: integer("attempt_count").notNull().default(0),
  deliveryVersion: integer("delivery_version").notNull().default(1),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_deliveries_receipt_once_uidx").on(table.transactionId, table.kind),
  index("email_deliveries_status_idx").on(table.status),
  check("email_deliveries_attempt_nonnegative", sql`${table.attemptCount} >= 0`),
  check("email_deliveries_version_positive", sql`${table.deliveryVersion} > 0`),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 120 }).notNull(),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  safeDetails: jsonb("safe_details").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_events_entity_idx").on(table.entityType, table.entityId)]);
