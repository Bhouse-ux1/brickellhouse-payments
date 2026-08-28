import "dotenv/config";
import { and, desc, eq, isNull, like } from "drizzle-orm";
import { createLocalAccountIssuer } from "better-auth/db";
import { hashPassword } from "better-auth/crypto";
import { createDatabase } from "@/db/client";
import { accounts, users, verifications } from "@/db/schema";
import { recordAuthAudit } from "@worker/services/auth-audit";
import { createProductionAuth, productionAuthConfigured } from "@worker/services/production-auth";
import { emailDeliveryConfigured } from "@worker/services/resend-email";
import type { WorkerBindings } from "@worker/types";

const PRODUCTION_AUTH_URL = "https://brickellhouse-payments.assistantmanager.workers.dev";
const VERIFIED_SENDER = "orders@brickellhouse.org";
const CREDENTIAL_PROVIDER = "credential";

function randomInaccessiblePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const env = process.env as unknown as WorkerBindings;
const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error("Set INITIAL_ADMIN_EMAIL locally to the approved administrator email.");
if (!productionAuthConfigured(env)) throw new Error("Set BETTER_AUTH_SECRET and BETTER_AUTH_URL locally before bootstrapping.");
if (!emailDeliveryConfigured(env)) throw new Error("Set RESEND_API_KEY and EMAIL_FROM locally before bootstrapping.");
if (env.BETTER_AUTH_URL?.replace(/\/$/u, "") !== PRODUCTION_AUTH_URL) throw new Error("BETTER_AUTH_URL must be the production BrickellHouse Payments URL.");
if (env.EMAIL_FROM?.trim().toLowerCase() !== VERIFIED_SENDER) throw new Error("EMAIL_FROM must be the approved verified BrickellHouse sender.");

const db = createDatabase(env);
if (!db) throw new Error("DATABASE_URL is required for the local bootstrap command.");

let emailAccepted = false;
let productionSetupUrl = false;
const auth = createProductionAuth(env, {
  throwOnEmailFailure: true,
  onAuthenticationEmailAccepted(event) {
    if (event.kind !== "password-reset") return;
    const setupUrl = new URL(event.url);
    emailAccepted = event.providerMessageId.length > 0;
    productionSetupUrl = setupUrl.origin === PRODUCTION_AUTH_URL
      && setupUrl.pathname.startsWith("/api/auth/reset-password/")
      && setupUrl.searchParams.get("callbackURL") === `${PRODUCTION_AUTH_URL}/reset-password`;
  },
});

let [adminUser] = await db.select({
  id: users.id,
  role: users.role,
  emailVerified: users.emailVerified,
}).from(users).where(eq(users.email, email)).limit(1);

let userCreated = false;
if (!adminUser) {
  const created = await auth.api.createUser({
    body: { email, name: "BrickellHouse Administrator", role: "ADMIN" },
  });
  userCreated = true;
  [adminUser] = await db.select({
    id: users.id,
    role: users.role,
    emailVerified: users.emailVerified,
  }).from(users).where(eq(users.id, created.user.id)).limit(1);
}
if (!adminUser) throw new Error("The Admin user could not be created or recovered.");

await db.update(users).set({
  role: "ADMIN",
  active: true,
  banned: false,
  banReason: null,
  banExpires: null,
  updatedAt: new Date(),
}).where(eq(users.id, adminUser.id));

const credentialIssuer = createLocalAccountIssuer(CREDENTIAL_PROVIDER);
const credentialAccounts = await db.select({
  id: accounts.id,
  issuer: accounts.issuer,
  accountId: accounts.accountId,
  password: accounts.password,
}).from(accounts).where(and(
  eq(accounts.userId, adminUser.id),
  eq(accounts.providerId, CREDENTIAL_PROVIDER),
));
if (credentialAccounts.length > 1) throw new Error("The Admin has duplicate credential accounts; no changes were made.");
const existingCredential = credentialAccounts[0];
if (existingCredential && (existingCredential.issuer !== credentialIssuer || existingCredential.accountId !== adminUser.id)) {
  throw new Error("The existing Admin credential account identity is inconsistent; no duplicate was created.");
}

let credentialAccountCreated = false;
if (!existingCredential || !existingCredential.password) {
  const bootstrapPasswordHash = await hashPassword(randomInaccessiblePassword());
  if (!existingCredential) {
    await db.insert(accounts).values({
      id: crypto.randomUUID(),
      issuer: credentialIssuer,
      accountId: adminUser.id,
      providerId: CREDENTIAL_PROVIDER,
      userId: adminUser.id,
      password: bootstrapPasswordHash,
    }).onConflictDoNothing();
    credentialAccountCreated = true;
  } else {
    await db.update(accounts).set({ password: bootstrapPasswordHash, updatedAt: new Date() })
      .where(and(eq(accounts.id, existingCredential.id), isNull(accounts.password)));
  }
}

const [recoveredAdmin] = await db.select({
  id: users.id,
  role: users.role,
  emailVerified: users.emailVerified,
  active: users.active,
}).from(users).where(eq(users.id, adminUser.id)).limit(1);
const [credential] = await db.select({
  id: accounts.id,
  password: accounts.password,
}).from(accounts).where(and(
  eq(accounts.userId, adminUser.id),
  eq(accounts.providerId, CREDENTIAL_PROVIDER),
  eq(accounts.issuer, credentialIssuer),
  eq(accounts.accountId, adminUser.id),
)).limit(1);
if (!recoveredAdmin?.active || recoveredAdmin.role !== "ADMIN" || !credential?.password) {
  throw new Error("The partial Admin account could not be repaired safely.");
}

if (recoveredAdmin.emailVerified) {
  console.log(JSON.stringify({
    adminValid: true,
    adminRole: "ADMIN",
    emailVerified: true,
    credentialAccountValid: true,
    setupAlreadyCompleted: true,
    setupEmailAcceptedByResend: false,
  }));
  process.exit(0);
}

await db.delete(verifications).where(and(
  eq(verifications.value, recoveredAdmin.id),
  like(verifications.identifier, "reset-password:%"),
));
await auth.api.requestPasswordReset({
  body: { email, redirectTo: `${PRODUCTION_AUTH_URL}/reset-password` },
});
if (!emailAccepted) throw new Error("Resend did not return an accepted message ID.");
if (!productionSetupUrl) throw new Error("The generated setup URL did not use the approved production origin and callback.");

const [setupToken] = await db.select({ expiresAt: verifications.expiresAt }).from(verifications)
  .where(and(eq(verifications.value, recoveredAdmin.id), like(verifications.identifier, "reset-password:%")))
  .orderBy(desc(verifications.expiresAt)).limit(1);
const tokenLifetimeSeconds = setupToken ? Math.round((setupToken.expiresAt.getTime() - Date.now()) / 1000) : 0;
if (tokenLifetimeSeconds < 55 * 60 || tokenLifetimeSeconds > 61 * 60) {
  throw new Error("The password setup token does not have the expected one-hour lifetime.");
}

await recordAuthAudit({
  db,
  action: "ADMIN_BOOTSTRAP_RECOVERED",
  entityId: recoveredAdmin.id,
  actorUserId: recoveredAdmin.id,
  details: { userCreated, credentialAccountCreated, setupEmailAccepted: true },
});

console.log(JSON.stringify({
  adminValid: true,
  adminRole: "ADMIN",
  emailVerified: false,
  credentialAccountValid: true,
  bootstrapPasswordInaccessible: true,
  setupTokenLifetime: "one-hour",
  setupEmailAcceptedByResend: true,
  sender: `BrickellHouse Management <${VERIFIED_SENDER}>`,
  productionSetupUrl: true,
  userCreated,
  partialUserRecovered: !userCreated,
}));
