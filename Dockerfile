# syntax=docker/dockerfile:1.7

# ─── Dependencies ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ─── Build ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# they are build args rather than runtime environment.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prebuild` copies Monaco's AMD bundle into public/monaco/vs.
RUN npm run build

# ─── Runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV WS_PORT=3000

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# The custom server (server/index.ts) runs through tsx and imports from
# src/ and server/, so both source trees ship with the image. tsx and cross-env
# are runtime dependencies because `npm start` uses both.
COPY package.json package-lock.json tsconfig.json next.config.ts ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=nextjs:nodejs --from=builder /app/.next ./.next
COPY --chown=nextjs:nodejs --from=builder /app/public ./public
COPY --chown=nextjs:nodejs --from=builder /app/server ./server
COPY --chown=nextjs:nodejs --from=builder /app/src ./src

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>r.ok&&(await r.json()).ok===true).then(v=>process.exit(v?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
