import postgres from "postgres";
import { databaseConnectionString, type DatabaseEnvironment } from "@/db/client";

type HealthSqlClient = {
  unsafe: (query: string) => Promise<Array<{ value?: number }>>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

export type DatabaseKeepaliveDependencies = {
  connect: (connectionString: string) => HealthSqlClient;
  now: () => number;
  info: (message: string, details: { durationMs: number }) => void;
  error: (message: string, details: { durationMs: number }) => void;
};

const defaultDependencies: DatabaseKeepaliveDependencies = {
  connect(connectionString) {
    return postgres(connectionString, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 5,
    });
  },
  now: () => Date.now(),
  info: (message, details) => console.info(message, details),
  error: (message, details) => console.error(message, details),
};

export async function runScheduledDatabaseKeepalive(
  env: DatabaseEnvironment,
  dependencies: DatabaseKeepaliveDependencies = defaultDependencies,
): Promise<void> {
  const startedAt = dependencies.now();
  const connectionString = databaseConnectionString(env);
  if (!connectionString) {
    dependencies.error("Scheduled database health check failed", { durationMs: dependencies.now() - startedAt });
    throw new Error("Database is not configured");
  }

  const sql = dependencies.connect(connectionString);
  try {
    const [result] = await sql.unsafe("SELECT 1::integer AS value");
    if (result?.value !== 1) throw new Error("Unexpected database health response");
    dependencies.info("Scheduled database health check succeeded", { durationMs: dependencies.now() - startedAt });
  } catch {
    dependencies.error("Scheduled database health check failed", { durationMs: dependencies.now() - startedAt });
    throw new Error("Scheduled database health check failed");
  } finally {
    await sql.end({ timeout: 5 });
  }
}
