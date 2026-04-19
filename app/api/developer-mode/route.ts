import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const COOKIE_NAME = "meetmind_dev_mode";
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const DEMO_PASSWORD_HASH = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4";

type UnlockRequest = {
  password?: string;
};

function hashPassword(password: string) {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

function getConfiguredPasswordHash() {
  return process.env.DEVELOPER_MODE_PASSWORD_HASH?.trim() || DEMO_PASSWORD_HASH;
}

function getSessionCookieValue() {
  return createHash("sha256").update(`meetmind-dev-mode:${getConfiguredPasswordHash()}`, "utf8").digest("hex");
}

function safeCompareHex(first: string, second: string) {
  if (!/^[a-f0-9]{64}$/i.test(first) || !/^[a-f0-9]{64}$/i.test(second)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));
}

function getCookieValue(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
}

function hasUnlockedCookie(request: Request) {
  return safeCompareHex(getCookieValue(request, COOKIE_NAME), getSessionCookieValue());
}

export async function GET(request: Request) {
  return NextResponse.json({ unlocked: hasUnlockedCookie(request) });
}

export async function POST(request: Request) {
  let payload: UnlockRequest;

  try {
    payload = (await request.json()) as UnlockRequest;
  } catch {
    return NextResponse.json({ error: "Expected JSON payload." }, { status: 400 });
  }

  const password = typeof payload.password === "string" ? payload.password : "";
  const passwordHash = hashPassword(password);
  const configuredHash = getConfiguredPasswordHash();

  if (!safeCompareHex(passwordHash, configuredHash)) {
    return NextResponse.json({ error: "Incorrect developer mode password." }, { status: 401 });
  }

  const response = NextResponse.json({ unlocked: true });

  response.cookies.set({
    name: COOKIE_NAME,
    value: getSessionCookieValue(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ unlocked: false });

  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });

  return response;
}
