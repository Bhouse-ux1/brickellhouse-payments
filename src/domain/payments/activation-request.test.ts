import { describe, expect, it, vi } from "vitest";
import { sendIdempotentPaymentActivation } from "./activation-request";

describe("single-click payment activation", () => {
  it("replays one interrupted request immediately without a timer or employee action", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await sendIdempotentPaymentActivation(request);
    expect(result.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not replay a completed request", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 409 }));
    const result = await sendIdempotentPaymentActivation(request);
    expect(result.status).toBe(409);
    expect(request).toHaveBeenCalledOnce();
  });
});
