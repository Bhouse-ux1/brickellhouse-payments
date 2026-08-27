import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@/db/client";
import * as schema from "@/db/schema";
import type { AuthorizedEmployee, WorkerBindings } from "./types";

export function createWorkerAuth(env: WorkerBindings) {
  const db = createDatabase(env);
  if (!db || !env.BETTER_AUTH_SECRET) return null;
  const microsoftConfigured = Boolean(
    env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_TENANT_ID,
  );
  return betterAuth({
    appName: "BrickellHouse Payments",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", usePlural: true, schema }),
    trustedOrigins: env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [],
    socialProviders: microsoftConfigured ? {
      microsoft: {
        clientId: env.MICROSOFT_CLIENT_ID!,
        clientSecret: env.MICROSOFT_CLIENT_SECRET!,
        tenantId: env.MICROSOFT_TENANT_ID!,
      },
    } : {},
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "EMPLOYEE", input: false },
        active: { type: "boolean", required: false, defaultValue: true, input: false },
      },
    },
  });
}

export async function readAuthorizedEmployee(request: Request, env: WorkerBindings): Promise<AuthorizedEmployee | null> {
  const auth = createWorkerAuth(env);
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  const user = session.user as typeof session.user & { role?: string; active?: boolean };
  const allowedRoles = ["ADMIN", "MANAGER", "EMPLOYEE", "ACCOUNTING"] as const;
  if (user.active === false || !allowedRoles.includes(user.role as (typeof allowedRoles)[number])) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role as AuthorizedEmployee["role"], active: true };
}
