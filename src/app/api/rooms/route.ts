import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

/** Create a room or validate a room key on the CodeSync API Worker. */
export async function GET(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key")?.trim();
  if (!key) {
    return Response.json(
      { error: "Missing key", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }
  return proxyToBackend(request, `/api/rooms?key=${encodeURIComponent(key)}`);
}

export async function POST(request: Request): Promise<Response> {
  return proxyToBackend(request, "/api/rooms");
}
