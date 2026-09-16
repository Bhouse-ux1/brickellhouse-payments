import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { productCatalog } from "@/domain/products/catalog";
import { createDraftTransaction } from "@/services/transactions/create-draft";

// Execute real PostgreSQL SQL in memory. Only adapt the driver's raw-result
// shape; query builders, predicates, constraints and transactions are Drizzle's.
function postgresResultShape(database: ReturnType<typeof drizzle<typeof schema>>): Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "execute") return async (query: SQL) => (await target.execute(query)).rows;
      if (property === "transaction") return (callback: (tx: Database) => Promise<unknown>, options?: Parameters<typeof target.transaction>[1]) =>
        target.transaction(tx => callback(postgresResultShape(tx as unknown as typeof database)), options);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Database;
}

export async function createPaymentTestDatabase() {
  const client = new PGlite();
  const directory = new URL("../../drizzle/", import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(file, directory), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  const db = postgresResultShape(drizzle(client, { schema }));
  const reset = async () => {
    await client.exec("TRUNCATE users, products, transactions, terminal_readers, stripe_events RESTART IDENTITY CASCADE");
    await db.insert(schema.users).values({ id: "test-admin", name: "Test Admin", email: "admin@example.invalid", role: "ADMIN", active: true, emailVerified: true });
    await db.insert(schema.products).values([...productCatalog]);
  };
  const draft = () => createDraftTransaction(db, { unitNumber: "TEST", customerEmail: "resident@example.invalid", items: [{ productId: "black_white_printing", quantity: 4 }], customCharges: [] }, "test-admin");
  return { client, db, reset, draft };
}
