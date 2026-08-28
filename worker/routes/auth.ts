import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "@/db/client";
import { users } from "@/db/schema";
import { readAuthorizedEmployee } from "@worker/auth";
import { emailFingerprint, recordAuthAudit, requestAuditContext } from "@worker/services/auth-audit";
import { createProductionAuth, productionAuthConfigured } from "@worker/services/production-auth";
import type { WorkerEnvironment } from "@worker/types";

export const authRoutes = new Hono<WorkerEnvironment>();

export function mayReceivePasswordReset(user: {
  active: boolean;
  banned: boolean;
  role: string;
}): boolean {
  return user.active && !user.banned && ["ADMIN", "STAFF"].includes(user.role);
}

authRoutes.get("/session", async (c) => {
  const employee = await readAuthorizedEmployee(c.req.raw, c.env);
  return employee ? c.json({ employee }) : c.json({ error: "Authentication required" }, 401);
});

export async function handleProductionAuthRequest(request: Request, env: WorkerEnvironment["Bindings"]): Promise<Response> {
  if (!productionAuthConfigured(env)) return Response.json({ error: "Production authentication is not configured" }, { status: 503 });
  const db = createDatabase(env);
  if (!db) return Response.json({ error: "Authentication database is not configured" }, { status: 503 });
  const url = new URL(request.url);
  const authPath = url.pathname.slice("/api/auth".length) || "/";
  const requestCopy = request.clone();
  const currentEmployee = authPath === "/sign-out" ? await readAuthorizedEmployee(request, env) : null;
  let email = "";
  if (["/sign-in/email", "/request-password-reset"].includes(authPath)) {
    const body = await requestCopy.json().catch(() => ({})) as { email?: unknown };
    if (typeof body.email === "string") email = body.email.trim().toLowerCase();
  }
  if (authPath === "/request-password-reset" && email) {
    const [resetUser] = await db.select({
      id: users.id, active: users.active, banned: users.banned, role: users.role,
    }).from(users).where(eq(users.email, email)).limit(1);
    if (resetUser && !mayReceivePasswordReset(resetUser)) {
      await recordAuthAudit({
        db, action: "PASSWORD_RESET_BLOCKED", entityId: resetUser.id,
        details: { ...requestAuditContext(request), status: 200 },
      });
      return Response.json({ status: true });
    }
  }
  const response = await createProductionAuth(env).handler(request);
  const context = requestAuditContext(request);
  if (authPath === "/sign-in/email") {
    const fingerprint = email ? await emailFingerprint(email) : "invalid-email";
    const [user] = email ? await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1) : [];
    await recordAuthAudit({
      db,
      action: response.ok ? "LOGIN_SUCCEEDED" : response.status === 429 ? "LOGIN_RATE_LIMITED" : "LOGIN_FAILED",
      entityId: user?.id ?? fingerprint,
      actorUserId: response.ok ? user?.id ?? null : null,
      details: { ...context, status: response.status },
    });
  } else if (authPath === "/sign-out") {
    await recordAuthAudit({
      db, action: "LOGOUT", entityId: currentEmployee?.id ?? "unknown-session",
      actorUserId: currentEmployee?.id ?? null, details: context,
    });
  } else if (authPath === "/request-password-reset") {
    await recordAuthAudit({
      db, action: response.status === 429 ? "PASSWORD_RESET_RATE_LIMITED" : "PASSWORD_RESET_REQUESTED",
      entityId: email ? await emailFingerprint(email) : "invalid-email", details: { ...context, status: response.status },
    });
  } else if (authPath === "/reset-password") {
    await recordAuthAudit({
      db, action: response.ok ? "PASSWORD_RESET_ACCEPTED" : "PASSWORD_RESET_REJECTED",
      entityId: "password-reset", details: { ...context, status: response.status },
    });
  }
  return response;
}
