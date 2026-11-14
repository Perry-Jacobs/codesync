import type { NextConfig } from "next";

/**
 * Monaco is served as a static AMD bundle from /public/monaco/vs (see
 * scripts/copy-monaco.mjs). That keeps webpack out of the Monaco worker
 * pipeline entirely and makes the CSP deterministic.
 */
const apiOrigin = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "");

const connectSources = ["'self'", "ws:", "wss:"];
if (apiOrigin?.startsWith("https://")) {
  connectSources.push(apiOrigin);
}

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src ${connectSources.join(" ")}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), display-capture=(self)",
  },
];

const nextConfig: NextConfig = {
  // Allows a secondary local preview to use an isolated build directory
  // without touching a running development server's .next output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["ioredis", "ws", "yjs"],
  devIndicators: false,
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
