/**
 * Browser-facing API configuration.
 *
 * When the frontend is deployed separately from the CodeSync Worker, set
 * NEXT_PUBLIC_API_URL to the Worker's public origin. Keeping the default
 * relative URL preserves the existing single-origin local development flow.
 */
export function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!base) return path;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
