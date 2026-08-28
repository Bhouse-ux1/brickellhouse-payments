import type { Database } from "@/db/client";
import { auditEvents } from "@/db/schema";

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function emailFingerprint(email: string): Promise<string> {
  return sha256(email.trim().toLowerCase());
}

export function requestAuditContext(request: Request) {
  return {
    ipAddress: (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown").slice(0, 80),
    userAgent: (request.headers.get("user-agent") ?? "unknown").slice(0, 240),
  };
}

export async function recordAuthAudit(input: {
  db: Database;
  action: string;
  entityId: string;
  actorUserId?: string | null;
  details?: Record<string, unknown>;
}) {
  await input.db.insert(auditEvents).values({
    actorUserId: input.actorUserId ?? null,
    action: input.action.slice(0, 120),
    entityType: "AUTHENTICATION",
    entityId: input.entityId.slice(0, 255),
    safeDetails: input.details ?? {},
  });
}
