import type { AuthorizedEmployee, WorkerBindings } from "@worker/types";

export const TEST_ACCESS_COOKIE = "bh_test_session";
export const TEST_EMPLOYEE: AuthorizedEmployee = {
  id: "brickellhouse-test-employee",
  name: "BrickellHouse Test Employee",
  email: "test-access@brickellhouse.invalid",
  role: "ADMIN",
  active: true,
};

const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function testAccessConfigured(env: WorkerBindings): boolean {
  return Boolean(env.TEST_ACCESS_PASSWORD && env.TEST_SESSION_SECRET && env.TEST_SESSION_SECRET.length >= 32);
}

export async function verifyTestAccessPassword(provided: string, env: WorkerBindings): Promise<boolean> {
  if (!testAccessConfigured(env) || !env.TEST_ACCESS_PASSWORD) return false;
  return constantTimeEqual(await digest(provided), await digest(env.TEST_ACCESS_PASSWORD));
}

export async function createTestAccessCookie(env: WorkerBindings, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.TEST_SESSION_SECRET || env.TEST_SESSION_SECRET.length < 32) throw new Error("Test access is not configured.");
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ sub: TEST_EMPLOYEE.id, exp: nowSeconds + SESSION_SECONDS })));
  const signature = base64UrlEncode(await hmac(payload, env.TEST_SESSION_SECRET));
  return `${TEST_ACCESS_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearTestAccessCookie(): string {
  return `${TEST_ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function readTestAccessSession(request: Request, env: WorkerBindings, nowSeconds = Math.floor(Date.now() / 1000)): Promise<AuthorizedEmployee | null> {
  if (!env.TEST_SESSION_SECRET || env.TEST_SESSION_SECRET.length < 32) return null;
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${TEST_ACCESS_COOKIE}=`));
  const token = cookie?.slice(TEST_ACCESS_COOKIE.length + 1);
  if (!token) return null;
  const [payload, suppliedSignature, ...extra] = token.split(".");
  if (!payload || !suppliedSignature || extra.length) return null;
  const suppliedBytes = base64UrlDecode(suppliedSignature);
  if (!suppliedBytes || !constantTimeEqual(suppliedBytes, await hmac(payload, env.TEST_SESSION_SECRET))) return null;
  const payloadBytes = base64UrlDecode(payload);
  if (!payloadBytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as { sub?: unknown; exp?: unknown };
    if (parsed.sub !== TEST_EMPLOYEE.id || typeof parsed.exp !== "number" || !Number.isSafeInteger(parsed.exp) || parsed.exp <= nowSeconds) return null;
    return TEST_EMPLOYEE;
  } catch {
    return null;
  }
}
