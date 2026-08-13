import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * Validates the pre-launch password and sets the gate cookie.
 *
 * The cookie holds the SHA-256 of the password, never the password. That does not make a stolen
 * cookie less usable than a stolen password, but it keeps the plaintext out of the browser's cookie
 * store, and the cookie is httpOnly so page scripts cannot read it either.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.SITE_PASSWORD;
  if (!secret) {
    // Matches the middleware's fail-open: with nothing configured there is nothing to check.
    return NextResponse.json({ ok: true, note: "no password configured" });
  }

  const form = await req.formData();
  const supplied = String(form.get("password") ?? "");

  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(secret).digest();
  // Hash first, then compare: timingSafeEqual throws on length mismatch, and hashing makes both
  // sides 32 bytes so the comparison itself leaks nothing about the password's length.
  const ok = timingSafeEqual(a, b);

  if (!ok) {
    const url = req.nextUrl.clone();
    url.pathname = "/gate";
    url.search = "?e=1";
    return NextResponse.redirect(url, { status: 303 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set("dominion_gate", b.toString("hex"), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
