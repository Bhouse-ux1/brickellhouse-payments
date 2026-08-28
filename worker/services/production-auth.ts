import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import type { AccessControl } from "better-auth/plugins";
import { adminAc, defaultAc } from "better-auth/plugins/admin/access";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@/db/client";
import {
  accounts, rateLimits, sessions, users, verifications,
} from "@/db/schema";
import { emailFingerprint, recordAuthAudit, requestAuditContext } from "@worker/services/auth-audit";
import { sendAuthenticationEmail } from "@worker/services/resend-email";
import type { WorkerBindings } from "@worker/types";

export const INACTIVITY_TIMEOUT_SECONDS = 30 * 60;
export const LOGIN_RATE_LIMIT = { window: 5 * 60, max: 5 } as const;
export const PUBLIC_SIGNUP_ENABLED = false;
const PASSWORD_RESET_SECONDS = 60 * 60;

type ProductionAuthRuntimeOptions = {
  throwOnEmailFailure?: boolean;
  onAuthenticationEmailAccepted?: (event: {
    kind: "password-reset" | "verify-email";
    url: string;
    providerMessageId: string;
  }) => void | Promise<void>;
};

const adminRole = defaultAc.newRole(adminAc.statements);
const staffRole = defaultAc.newRole({ user: [], session: [] });

export function productionAuthConfigured(env: WorkerBindings): boolean {
  return Boolean(env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32 && env.BETTER_AUTH_URL?.startsWith("https://"));
}

export function createProductionAuth(env: WorkerBindings, runtime: ProductionAuthRuntimeOptions = {}) {
  const db = createDatabase(env);
  if (!db || !productionAuthConfigured(env) || !env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
    throw new Error("Production authentication is not configured.");
  }
  const sendAuthEmail = async (input: { user: { id: string; email: string }; url: string; token: string; kind: "password-reset" | "verify-email"; request?: Request }) => {
    const fingerprint = await emailFingerprint(input.token);
    let providerMessageId: string;
    try {
      providerMessageId = await sendAuthenticationEmail({ env, to: input.user.email, kind: input.kind, url: input.url, tokenFingerprint: fingerprint });
    } catch (error) {
      console.error("Authentication email delivery failed", {
        kind: input.kind,
        userId: input.user.id,
        message: error instanceof Error ? error.message : "Unknown email failure",
      });
      await recordAuthAudit({
        db,
        action: input.kind === "password-reset" ? "PASSWORD_RESET_EMAIL_FAILED" : "EMAIL_VERIFICATION_FAILED",
        entityId: input.user.id,
        actorUserId: input.user.id,
        details: input.request ? requestAuditContext(input.request) : {},
      });
      if (runtime.throwOnEmailFailure) throw new Error("Authentication email delivery was rejected.", { cause: error });
      return;
    }
    await recordAuthAudit({
      db,
      action: input.kind === "password-reset" ? "PASSWORD_RESET_EMAIL_SENT" : "EMAIL_VERIFICATION_SENT",
      entityId: input.user.id,
      actorUserId: input.user.id,
      details: input.request ? requestAuditContext(input.request) : {},
    });
    await runtime.onAuthenticationEmailAccepted?.({ kind: input.kind, url: input.url, providerMessageId });
  };

  return betterAuth({
    appName: "BrickellHouse Management",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.BETTER_AUTH_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: rateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !PUBLIC_SIGNUP_ENABLED,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }, request) => {
        await sendAuthEmail({ user, url, token, kind: "password-reset", request });
      },
      onPasswordReset: async ({ user }, request) => {
        await db.update(users).set({ emailVerified: true, updatedAt: new Date() }).where(eq(users.id, user.id));
        await recordAuthAudit({
          db, action: "PASSWORD_RESET_COMPLETED", entityId: user.id, actorUserId: user.id,
          details: request ? requestAuditContext(request) : {},
        });
      },
    },
    emailVerification: {
      expiresIn: PASSWORD_RESET_SECONDS,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url, token }, request) => {
        await sendAuthEmail({ user, url, token, kind: "verify-email", request });
      },
    },
    session: {
      expiresIn: INACTIVITY_TIMEOUT_SECONDS,
      updateAge: 5 * 60,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        active: { type: "boolean", defaultValue: true, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [employee] = await db.select({ active: users.active, banned: users.banned, banExpires: users.banExpires })
              .from(users).where(eq(users.id, session.userId)).limit(1);
            const activelyBanned = employee?.banned && (!employee.banExpires || employee.banExpires > new Date());
            if (!employee?.active || activelyBanned) throw new APIError("FORBIDDEN", { message: "This employee account is not active." });
            return { data: session };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rateLimit",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": LOGIN_RATE_LIMIT,
        "/request-password-reset": { window: 15 * 60, max: 3 },
        "/reset-password": { window: 15 * 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: env.ENVIRONMENT !== "development",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.ENVIRONMENT !== "development",
        sameSite: "strict",
        path: "/",
      },
    },
    plugins: [admin({
      defaultRole: "STAFF",
      adminRoles: ["ADMIN"],
      ac: defaultAc as unknown as AccessControl,
      roles: { ADMIN: adminRole, STAFF: staffRole },
      bannedUserMessage: "This employee account is not active.",
    })],
    telemetry: { enabled: false },
  });
}
