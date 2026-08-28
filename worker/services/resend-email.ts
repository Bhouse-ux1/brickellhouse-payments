import type { WorkerBindings } from "@worker/types";

export class EmailConfigurationError extends Error {
  constructor(message = "Email delivery is not configured") {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

export function emailDeliveryConfigured(env: WorkerBindings): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(env.EMAIL_FROM));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export async function sendResendEmail(input: {
  env: WorkerBindings;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  if (!emailDeliveryConfigured(input.env) || !input.env.RESEND_API_KEY || !input.env.EMAIL_FROM) {
    throw new EmailConfigurationError();
  }
  const response = await (input.fetcher ?? fetch).call(globalThis, "https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify({
      from: `BrickellHouse Management <${input.env.EMAIL_FROM}>`,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  const body = await response.json() as { id?: string; message?: string };
  if (!response.ok || !body.id) throw new Error(`Email provider rejected the request (${response.status}).`);
  return body.id;
}

function authEmailLayout(input: { heading: string; copy: string; action: string; url: string }) {
  const safeUrl = escapeHtml(input.url);
  const html = `<!doctype html><html><body style="margin:0;background:#eee9df;color:#252824;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:48px 20px"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#174c3c">BrickellHouse Management</div><div style="margin-top:22px;padding:32px;background:#fffdf8;border:1px solid #d9d2c5"><h1 style="margin:0 0 12px;font-size:25px;font-weight:500">${escapeHtml(input.heading)}</h1><p style="margin:0 0 24px;color:#646963;line-height:1.55">${escapeHtml(input.copy)}</p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#174c3c;color:#fff;text-decoration:none;border-radius:3px">${escapeHtml(input.action)}</a><p style="margin:24px 0 0;color:#858983;font-size:12px;line-height:1.5">If you did not request this, you can ignore this message.</p></div></div></body></html>`;
  const text = `BrickellHouse Management\n\n${input.heading}\n${input.copy}\n\n${input.url}\n`;
  return { html, text };
}

export async function sendAuthenticationEmail(input: {
  env: WorkerBindings;
  to: string;
  kind: "password-reset" | "verify-email";
  url: string;
  tokenFingerprint: string;
  fetcher?: typeof fetch;
}) {
  const reset = input.kind === "password-reset";
  const content = authEmailLayout({
    heading: reset ? "Set your BrickellHouse password" : "Verify your email",
    copy: reset ? "Use this secure link to set a new password for your employee account. The link expires in one hour." : "Confirm this email address to activate your employee account.",
    action: reset ? "Set password" : "Verify email",
    url: input.url,
  });
  return sendResendEmail({
    env: input.env,
    to: input.to,
    subject: reset ? "Set your BrickellHouse password" : "Verify your BrickellHouse email",
    ...content,
    idempotencyKey: `auth/${input.kind}/${input.tokenFingerprint}`,
    fetcher: input.fetcher,
  });
}
