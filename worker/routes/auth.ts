import { Hono } from "hono";
import { createWorkerAuth, readAuthorizedEmployee } from "@worker/auth";
import type { WorkerEnvironment } from "@worker/types";

export const authRoutes = new Hono<WorkerEnvironment>();

authRoutes.get("/session", async (c) => {
  const employee = await readAuthorizedEmployee(c.req.raw, c.env);
  return employee ? c.json({ employee }) : c.json({ error: "Authentication required" }, 401);
});

authRoutes.all("/auth/*", async (c) => {
  const auth = createWorkerAuth(c.env);
  if (!auth) return c.json({ error: "Employee sign-in is not configured" }, 503);
  return auth.handler(c.req.raw);
});
