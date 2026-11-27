import { NextResponse, type NextRequest } from "next/server";

/** Session keys are `zk-` + 18 nanoid chars (21 total). */
const SESSION_KEY_RE = /^zk-[A-Za-z0-9_-]{18}$/;

const NO_STORE = "no-store, max-age=0, must-revalidate";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // API paths are not session-key scoped. They bypass key validation while
  // retaining the same no-store policy as real-time surfaces.
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", NO_STORE);
    response.headers.set("Pragma", "no-cache");
    return response;
  }

  // Real-time surfaces must never be cached by the browser, CDN or Next.
  if (pathname.startsWith("/room/") || pathname.startsWith("/join/")) {
    const key = pathname.split("/")[2];
    // A missing or malformed key is invalid; an empty segment (e.g. /room/)
    // must not slip through validation.
    if (!key || !SESSION_KEY_RE.test(key)) {
      const url = new URL("/join", request.url);
      url.searchParams.set("invalidKey", "1");
      return NextResponse.redirect(url);
    }
    const response = NextResponse.next();
    response.headers.set("Cache-Control", NO_STORE);
    response.headers.set("Pragma", "no-cache");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|monaco|favicon.ico|icon.svg).*)"],
};
