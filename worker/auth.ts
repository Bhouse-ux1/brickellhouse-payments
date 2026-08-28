import { eq } from "drizzle-orm";
import { createDatabase } from "@/db/client";
import { users } from "@/db/schema";
import { createProductionAuth, productionAuthConfigured } from "./services/production-auth";
import type { AuthorizedEmployee, EmployeeRole, WorkerBindings } from "./types";

export async function readAuthorizedEmployee(request: Request, env: WorkerBindings): Promise<AuthorizedEmployee | null> {
  if (!productionAuthConfigured(env)) return null;
  const db = createDatabase(env);
  if (!db) return null;
  const session = await createProductionAuth(env).api.getSession({ headers: request.headers });
  if (!session?.user.id) return null;
  const [user] = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role,
    active: users.active, emailVerified: users.emailVerified, banned: users.banned, banExpires: users.banExpires,
  }).from(users).where(eq(users.id, session.user.id)).limit(1);
  const activelyBanned = user?.banned && (!user.banExpires || user.banExpires > new Date());
  if (!user?.active || !user.emailVerified || activelyBanned || !["ADMIN", "STAFF"].includes(user.role)) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role as EmployeeRole, active: true };
}
