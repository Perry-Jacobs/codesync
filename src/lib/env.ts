import { z } from "zod";

/**
 * Server-only environment. Parsed lazily because the custom server loads
 * `.env` files *after* module evaluation (see server/index.ts).
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  WS_PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]*$/, "may only contain letters, numbers, :, _ and -")
    .default(""),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(1),
  MAX_PARTICIPANTS: z.coerce.number().int().min(2).max(16).default(8),
  RATE_LIMIT_MSGS_PER_SEC: z.coerce.number().int().positive().default(60),
  ROOM_CREATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(30),
  ROOM_CREATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(600),
  TRUST_PROXY_HEADERS: z.enum(["true", "false"]).default("false"),
  JWT_SECRET: z
    .string()
    .min(16)
    .default("dev-only-change-me-dev-only-change-me"),
  TURN_SERVER: z.string().default(""),
  TURN_USERNAME: z.string().default("codesync"),
  TURN_PASSWORD: z.string().default(""),
  TURN_SECRET: z.string().default(""),
  STUN_SERVERS: z.string().default("stun:stun.l.google.com:19302"),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  NEXT_PUBLIC_WS_URL: z.string().default(""),
});

export type ServerEnv = z.infer<typeof envSchema> & {
  allowedOrigins: string[];
  stunServers: string[];
  roomTtlSeconds: number;
  isProduction: boolean;
};

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    if (value.JWT_SECRET.length < 32) {
      throw new Error(
        "Invalid environment configuration: JWT_SECRET must be at least 32 characters in production",
      );
    }
    if (value.JWT_SECRET === "dev-only-change-me-dev-only-change-me") {
      throw new Error(
        "Invalid environment configuration: JWT_SECRET must not use the development default in production",
      );
    }
  }
  cached = {
    ...value,
    allowedOrigins: value.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    stunServers: value.STUN_SERVERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    roomTtlSeconds: Math.round(value.SESSION_TTL_HOURS * 3600),
    isProduction: value.NODE_ENV === "production",
  };
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
