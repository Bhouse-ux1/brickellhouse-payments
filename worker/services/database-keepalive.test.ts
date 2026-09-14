import { describe, expect, it, vi } from "vitest";
import { runScheduledDatabaseKeepalive, type DatabaseKeepaliveDependencies } from "./database-keepalive";

describe("scheduled database keepalive", () => {
  it("executes only a read-only SELECT 1 and closes the connection", async () => {
    const unsafe = vi.fn(async () => [{ value: 1 }]);
    const end = vi.fn(async () => undefined);
    const info = vi.fn();
    const error = vi.fn();
    const dependencies: DatabaseKeepaliveDependencies = {
      connect: vi.fn(() => ({ unsafe, end })),
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
      info,
      error,
    };

    await runScheduledDatabaseKeepalive(
      { HYPERDRIVE: { connectionString: "postgresql://placeholder" } as Hyperdrive },
      dependencies,
    );

    expect(unsafe).toHaveBeenCalledOnce();
    expect(unsafe).toHaveBeenCalledWith("SELECT 1::integer AS value");
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
    expect(info).toHaveBeenCalledWith("Scheduled database health check succeeded", { durationMs: 25 });
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed without invoking any external side-effect dependency", async () => {
    const connect = vi.fn();
    const error = vi.fn();
    await expect(runScheduledDatabaseKeepalive({}, {
      connect,
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(15),
      info: vi.fn(),
      error,
    })).rejects.toThrow("Database is not configured");
    expect(connect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Scheduled database health check failed", { durationMs: 5 });
  });
});
