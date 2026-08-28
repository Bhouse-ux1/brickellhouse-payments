import { describe, expect, it, vi } from "vitest";
import { sendResendEmail } from "./resend-email";

describe("Resend boundary", () => {
  it("keeps the API key server-side and sends a stable provider idempotency key", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer re_private");
      expect(headers.get("idempotency-key")).toBe("receipt/transaction-1/v1");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("apiKey");
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    });
    const input = {
      env: { RESEND_API_KEY: "re_private", EMAIL_FROM: "receipts@example.com" },
      to: "resident@example.com", subject: "Receipt", html: "<p>Receipt</p>", text: "Receipt",
      idempotencyKey: "receipt/transaction-1/v1", fetcher: fetcher as typeof fetch,
    };
    await expect(sendResendEmail(input)).resolves.toBe("email_1");
    await expect(sendResendEmail(input)).resolves.toBe("email_1");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("idempotency-key"))
      .toBe(new Headers(fetcher.mock.calls[1][1]?.headers).get("idempotency-key"));
  });
});
