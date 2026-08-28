import { Hono } from "hono";
import { createDatabase } from "@/db/client";
import { users } from "@/db/schema";
import { readAuthorizedEmployee } from "@worker/auth";
import {
  TEST_EMPLOYEE, clearTestAccessCookie, createTestAccessCookie,
  testAccessConfigured, verifyTestAccessPassword,
} from "@worker/services/test-access";
import type { WorkerEnvironment } from "@worker/types";

export const authRoutes = new Hono<WorkerEnvironment>();

authRoutes.get("/session", async (c) => {
  const employee = await readAuthorizedEmployee(c.req.raw, c.env);
  return employee ? c.json({ employee }) : c.json({ error: "Authentication required" }, 401);
});

authRoutes.post("/test-access/login", async (c) => {
  if (!testAccessConfigured(c.env)) return c.json({ error: "Test access is not configured" }, 503);
  const body: { password?: unknown } = await c.req.json<{ password?: unknown }>().catch(() => ({}));
  if (typeof body.password !== "string" || body.password.length > 512 || !(await verifyTestAccessPassword(body.password, c.env))) {
    return c.json({ error: "Invalid access password" }, 401);
  }
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Test access database is not configured" }, 503);
  await db.insert(users).values({
    id: TEST_EMPLOYEE.id, name: TEST_EMPLOYEE.name, email: TEST_EMPLOYEE.email,
    role: TEST_EMPLOYEE.role, active: true, emailVerified: false,
  }).onConflictDoUpdate({ target: users.id, set: { name: TEST_EMPLOYEE.name, active: true, updatedAt: new Date() } });
  c.header("set-cookie", await createTestAccessCookie(c.env));
  return c.json({ employee: TEST_EMPLOYEE });
});

authRoutes.post("/test-access/logout", (c) => {
  c.header("set-cookie", clearTestAccessCookie());
  return c.json({ ok: true });
});
