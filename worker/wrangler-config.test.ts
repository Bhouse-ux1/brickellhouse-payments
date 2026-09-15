import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Worker observability configuration", () => {
  it("keeps logs and invocation logs enabled for future deployments", () => {
    const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      observability?: { enabled?: boolean; logs?: { enabled?: boolean; invocation_logs?: boolean } };
    };
    expect(config.observability?.enabled).toBe(true);
    expect(config.observability?.logs?.enabled).toBe(true);
    expect(config.observability?.logs?.invocation_logs).toBe(true);
  });
});
