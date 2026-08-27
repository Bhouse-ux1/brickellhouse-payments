export type EmployeeRole = "ADMIN" | "MANAGER" | "EMPLOYEE" | "ACCOUNTING";

export type WorkerBindings = {
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_TERMINAL_READER_ID?: string;
  STRIPE_TERMINAL_LOCATION_ID?: string;
  STRIPE_TERMINAL_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ENVIRONMENT?: "development" | "staging" | "production";
};

export type AuthorizedEmployee = {
  id: string;
  name: string;
  email: string;
  role: EmployeeRole;
  active: boolean;
};

export type WorkerVariables = { employee: AuthorizedEmployee };
export type WorkerEnvironment = { Bindings: WorkerBindings; Variables: WorkerVariables };
