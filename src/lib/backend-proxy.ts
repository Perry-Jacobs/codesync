import { NextResponse } from "next/server";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
} as const;

/**
 * Resolve the separately deployed CodeSync API Worker.
 *
 * In production this is set as a Cloudflare Worker variable or secret. During
 * local development it can point at `wrangler dev --port 8787`.
 */
function backendOrigin(): string | null {
  const value =
    process.env.CODE_SYNC_API_ORIGIN?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!value) return null;
  return value.replace(/\/$/, "");
}

/** Proxy a browser request to the Cloudflare backend Worker. */
export async function proxyToBackend(
  request: Request,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const origin = backendOrigin();
  if (!origin) {
    return NextResponse.json(
      {
        error: "The CodeSync API is not configured",
        code: "UNAVAILABLE",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const headers = new Headers(init?.headers);
  const incoming = request.headers;
  const contentType = incoming.get("content-type");
  if (contentType && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  const authorization = incoming.get("authorization");
  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }
  const clientId = incoming.get("x-codesync-client-id");
  if (clientId && !headers.has("x-codesync-client-id")) {
    headers.set("x-codesync-client-id", clientId);
  }

  const method = init?.method ?? request.method;
  // Node's fetch requires `duplex: "half"` for streaming request bodies.
  // Buffering the small JSON request avoids that runtime-specific constraint
  // and keeps the proxy compatible with both Node and Cloudflare runtimes.
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : (init?.body ?? (await request.arrayBuffer()));

  try {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      method,
      headers,
      body,
      redirect: "manual",
    });
    const responseHeaders = new Headers();
    const responseType = response.headers.get("content-type");
    if (responseType) responseHeaders.set("content-type", responseType);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) responseHeaders.set("retry-after", retryAfter);
    Object.entries(NO_STORE_HEADERS).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json(
      {
        error: "The CodeSync API is temporarily unavailable",
        code: "UNAVAILABLE",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
