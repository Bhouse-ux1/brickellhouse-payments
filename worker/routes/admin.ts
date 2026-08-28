import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { createDatabase } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { requireAdmin } from "@worker/middleware/require-admin";
import { recordAuthAudit, requestAuditContext } from "@worker/services/auth-audit";
import { createProductionAuth } from "@worker/services/production-auth";
import { emailDeliveryConfigured } from "@worker/services/resend-email";
import type { WorkerEnvironment } from "@worker/types";

const createEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  role: z.enum(["ADMIN", "STAFF"]),
});

const updateEmployeeSchema = z.object({
  active: z.boolean(),
  role: z.enum(["ADMIN", "STAFF"]),
});

function randomBootstrapPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const adminRoutes = new Hono<WorkerEnvironment>();
adminRoutes.use("/*", requireAdmin);

adminRoutes.get("/users", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Employee administration is not configured" }, 503);
  const rows = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role,
    active: users.active, emailVerified: users.emailVerified, createdAt: users.createdAt,
  }).from(users);
  return c.json({ users: rows.filter((user) => ["ADMIN", "STAFF"].includes(user.role)) });
});

adminRoutes.post("/users", async (c) => {
  if (!emailDeliveryConfigured(c.env)) return c.json({ error: "Employee invitation email is not configured" }, 503);
  const parsed = createEmployeeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid employee details" }, 400);
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Employee administration is not configured" }, 503);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email)).limit(1);
  if (existing) return c.json({ error: "An employee account already uses this email" }, 409);
  const auth = createProductionAuth(c.env);
  const created = await auth.api.createUser({
    headers: c.req.raw.headers,
    body: {
      name: parsed.data.name,
      email: parsed.data.email,
      password: randomBootstrapPassword(),
      role: parsed.data.role,
    },
  });
  await db.update(users).set({ active: true, emailVerified: false, updatedAt: new Date() }).where(eq(users.id, created.user.id));
  await auth.api.requestPasswordReset({
    body: { email: parsed.data.email, redirectTo: `${c.env.BETTER_AUTH_URL}/reset-password` },
  });
  const actor = c.get("employee");
  await recordAuthAudit({
    db, action: "ADMIN_USER_CREATED", entityId: created.user.id, actorUserId: actor.id,
    details: { ...requestAuditContext(c.req.raw), assignedRole: parsed.data.role },
  });
  return c.json({ user: { id: created.user.id, name: parsed.data.name, email: parsed.data.email, role: parsed.data.role, active: true, emailVerified: false } }, 201);
});

adminRoutes.patch("/users/:id", async (c) => {
  const parsed = updateEmployeeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid employee update" }, 400);
  const actor = c.get("employee");
  if (actor.id === c.req.param("id") && (!parsed.data.active || parsed.data.role !== "ADMIN")) {
    return c.json({ error: "Administrators cannot remove their own access" }, 409);
  }
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Employee administration is not configured" }, 503);
  const [updated] = await db.update(users).set({
    active: parsed.data.active,
    role: parsed.data.role,
    banned: !parsed.data.active,
    banReason: parsed.data.active ? null : "Access disabled by an administrator",
    banExpires: null,
    updatedAt: new Date(),
  }).where(eq(users.id, c.req.param("id"))).returning({ id: users.id });
  if (!updated) return c.json({ error: "Employee not found" }, 404);
  if (!parsed.data.active) await db.delete(sessions).where(eq(sessions.userId, updated.id));
  await recordAuthAudit({
    db, action: "ADMIN_USER_UPDATED", entityId: updated.id, actorUserId: actor.id,
    details: { ...requestAuditContext(c.req.raw), active: parsed.data.active, assignedRole: parsed.data.role },
  });
  return c.json({ ok: true });
});

adminRoutes.post("/users/:id/send-password-setup", async (c) => {
  if (!emailDeliveryConfigured(c.env)) return c.json({ error: "Employee invitation email is not configured" }, 503);
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Employee administration is not configured" }, 503);
  const [user] = await db.select({ id: users.id, email: users.email, active: users.active }).from(users)
    .where(eq(users.id, c.req.param("id"))).limit(1);
  if (!user || !user.active) return c.json({ error: "Active employee not found" }, 404);
  await createProductionAuth(c.env).api.requestPasswordReset({
    body: { email: user.email, redirectTo: `${c.env.BETTER_AUTH_URL}/reset-password` },
  });
  const actor = c.get("employee");
  await recordAuthAudit({
    db, action: "ADMIN_PASSWORD_SETUP_SENT", entityId: user.id, actorUserId: actor.id,
    details: requestAuditContext(c.req.raw),
  });
  return c.json({ ok: true });
});
