import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { products } from "./schema";
import { productCatalog } from "../domain/products/catalog";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. No database was changed.");
const queryClient = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(queryClient);

for (const product of productCatalog) {
  await db.insert(products).values(product).onConflictDoUpdate({
    target: products.id,
    set: {
      displayName: product.displayName,
      priceCents: product.priceCents,
      glCode: product.glCode,
      active: product.active,
      terminalEnabled: product.terminalEnabled,
      quantityAllowed: product.quantityAllowed,
      category: product.category,
      updatedAt: new Date(),
    },
  });
}

await queryClient.end();
console.info(`Seeded ${productCatalog.length} trusted products.`);
