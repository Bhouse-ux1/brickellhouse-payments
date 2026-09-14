import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const migrationUrl = process.env.SUPABASE_SESSION_POOLER_URL;
if (!migrationUrl) {
  throw new Error("SUPABASE_SESSION_POOLER_URL is required for database migrations.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: migrationUrl,
  },
  strict: true,
  verbose: true,
});
