import { createMiddleware } from "hono/factory";
import { readAuthorizedEmployee } from "@worker/auth";
import type { WorkerEnvironment } from "@worker/types";

export const requireEmployee = createMiddleware<WorkerEnvironment>(async (c, next) => {
  const employee = await readAuthorizedEmployee(c.req.raw, c.env);
  if (!employee) return c.json({ error: "Authentication required" }, 401);
  c.set("employee", employee);
  await next();
});
