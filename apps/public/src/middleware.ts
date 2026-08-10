import { NextRequest, NextResponse } from "next/server";

/**
 * Pre-launch gate. Everything is behind a password except the announcement page and the handful of
 * paths that MUST stay reachable by machines.
 *
 * WHAT IS DELIBERATELY PUBLIC, AND WHY EACH ONE MATTERS:
 *
 *  - `/silv-metadata.json` and `/silv.png`. This is the token metadata whose URI is written into the
 *    SILV mint at creation. Wallets, explorers and aggregators fetch it anonymously, and the launch
 *    readiness gate fetches it too. Putting it behind the password would break the token's own
 *    identity and re-open the BLOCKING item that publishing it closed. It is public data by design.
 *  - The icons, because the announcement page renders them and browsers request favicons without
 *    cookies.
 *  - `/_next/*`, or the announcement page arrives unstyled.
 *
 * Everything else, the dapp and the price proxy included, needs the cookie. The proxy is gated on
 * purpose: it spends Pyth Lazer quota, and there is no reason for an anonymous visitor to spend it
 * before launch.
 */

const COOKIE = "dominion_gate";

/** Paths that must answer without a cookie. Prefix match, so `/silv.png` and nothing else. */
const PUBLIC_PATHS = [
  "/gate",
  "/api/gate",
  "/silv-metadata.json",
  "/silv.png",
  "/logo.png",
  "/icon.png",
  "/apple-icon.png",
  "/favicon.ico",
];

/** Hex sha256, the value the cookie is expected to hold. Never the password itself. */
async function expectedToken(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent compare, so a wrong cookie cannot be narrowed down byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const secret = process.env.SITE_PASSWORD;
  // FAIL OPEN IF UNCONFIGURED, and this is the considered choice rather than an oversight. A missing
  // env var would otherwise lock the app out of its own preview deployments with no way back in, and
  // the thing being protected here is an unlaunched UI, not funds: every privileged action on chain
  // is gated by a signature and a 3-of-5 multisig regardless of who can load the page.
  if (!secret) return NextResponse.next();

  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie && safeEqual(cookie, await expectedToken(secret))) {
    return NextResponse.next();
  }

  // API ROUTES GET A STATUS, NOT A PAGE. Rewriting an API request to the gate returned the HTML
  // announcement with a 200, which is a lie to any caller that reads status codes: measured on the
  // first build, `POST /api/lazer` answered 200 with a `<!DOCTYPE html>` body. Blocked is blocked,
  // and it should say so.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized: pre-launch" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.search = "";
  // A REWRITE, not a redirect: the visitor keeps the URL they asked for, so a link shared before
  // launch still lands on the right page once they have the password.
  return NextResponse.rewrite(url);
}

export const config = {
  // Skip Next's internals here as well as in PUBLIC_PATHS, so the middleware is not invoked at all
  // for asset requests.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
