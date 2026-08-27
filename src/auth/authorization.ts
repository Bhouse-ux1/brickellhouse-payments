export type EmployeeRole = "ADMIN" | "MANAGER" | "EMPLOYEE" | "ACCOUNTING";

export type AuthorizationIdentity = { active: boolean; role: EmployeeRole } | null;

export function authorizeEmployee(identity: AuthorizationIdentity, allowedRoles?: readonly EmployeeRole[]) {
  if (!identity || !identity.active) return "AUTHENTICATION_REQUIRED" as const;
  if (allowedRoles && !allowedRoles.includes(identity.role)) return "FORBIDDEN" as const;
  return "AUTHORIZED" as const;
}
