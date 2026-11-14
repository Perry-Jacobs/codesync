import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ key: string }>;
}

export async function GET(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const { key } = await params;
  return proxyToBackend(request, `/api/rooms/${encodeURIComponent(key)}`);
}
