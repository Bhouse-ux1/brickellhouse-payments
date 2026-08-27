import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export type DatabaseEnvironment = {
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
};

export function databaseConnectionString(env: DatabaseEnvironment): string | null {
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? null;
}

export function createDatabase(env: DatabaseEnvironment): Database | null {
  const connectionString = databaseConnectionString(env);
  if (!connectionString) return null;
  const client = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    prepare: true,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}
