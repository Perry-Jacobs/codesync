import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AUTH_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  WS_CLOSE,
  WS_HEARTBEAT_MS,
} from "@/lib/ws-protocol";
import { getEnv } from "@/lib/env";
import { createLogger } from "../logger";
import { createSocketContext, type SocketContext } from "./connection";
import { routeMessage } from "./router";
import { detachSocket } from "./handlers/room";
import { initBus, shutdownBus } from "./broadcast";
import { flushAll, liveDocCount } from "../yjs/store";
import { publishFsCancellation, rejectRoomRequests } from "../fs/pending";

const log = createLogger({ scope: "gateway" });
const MAX_CONNECTIONS = 1_000;
const MAX_CONNECTIONS_PER_IP = 20;

export interface Gateway {
  port: number;
  close(): Promise<void>;
}

function originAllowed(origin: string | null): boolean {
  // Non-browser clients omit Origin; browsers always send it (CSWSH guard).
  if (!origin) return true;
  const env = getEnv();
  if (env.allowedOrigins.includes(origin)) return true;
  if (!env.isProduction) {
    try {
      const { hostname } = new URL(origin);
      return hostname === "localhost" || hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }
  return false;
}

function clientIp(
  header: string | string[] | undefined,
  fallback: string | undefined,
): string {
  if (getEnv().TRUST_PROXY_HEADERS === "true") {
    const forwarded = Array.isArray(header) ? header[0] : header;
    if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return fallback ?? "unknown";
}

export async function startGateway(
  sharedHttpServer?: HttpServer,
): Promise<Gateway> {
  const env = getEnv();
  await initBus();

  const sharedSinglePort = Boolean(
    sharedHttpServer && env.WS_PORT === env.PORT,
  );
  const httpServer = sharedSinglePort
    ? sharedHttpServer!
    : createServer((req, res) => {
        if (req.url === "/healthz") {
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(
            JSON.stringify({
              ok: true,
              uptimeSec: Math.round(process.uptime()),
              liveDocs: liveDocCount(),
              connections: contexts.size,
            }),
          );
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
      });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const handleUpgrade = (
    request: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void => {
    const path = request.url?.split("?", 1)[0] ?? "/";
    if (path !== "/" && path !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };

  if (sharedSinglePort) {
    // In single-port mode, leave non-WebSocket upgrades alone so Next.js can
    // continue handling its development HMR socket.
    sharedHttpServer!.on("upgrade", (request, socket, head) => {
      const path = request.url?.split("?", 1)[0];
      if (path !== "/ws") return;
      handleUpgrade(request, socket, head);
    });
  } else {
    // The dedicated gateway listener supports an explicitly configured
    // separate WebSocket port.
    httpServer.on("upgrade", handleUpgrade);

    // A shared public listener can also expose the gateway at /ws when the
    // internal gateway uses a different port.
    if (sharedHttpServer && env.isProduction) {
      sharedHttpServer.on("upgrade", (request, socket, head) => {
        const path = request.url?.split("?", 1)[0];
        if (path !== "/ws") {
          socket.destroy();
          return;
        }
        handleUpgrade(request, socket, head);
      });
    }
  }

  const contexts = new Map<WebSocket, SocketContext>();
  const connectionsByIp = new Map<string, number>();

  wss.on("connection", (ws, req) => {
    if (!originAllowed(req.headers.origin ?? null)) {
      ws.close(WS_CLOSE.FORBIDDEN, "Origin not allowed");
      return;
    }

    const ip = clientIp(
      req.headers["x-forwarded-for"],
      req.socket.remoteAddress,
    );
    const ipConnectionCount = connectionsByIp.get(ip) ?? 0;
    if (
      contexts.size >= MAX_CONNECTIONS ||
      ipConnectionCount >= MAX_CONNECTIONS_PER_IP
    ) {
      ws.close(WS_CLOSE.RATE_LIMITED, "Connection limit exceeded");
      return;
    }
    connectionsByIp.set(ip, ipConnectionCount + 1);

    const ctx = createSocketContext(ws, ip, req.headers.origin ?? null);
    contexts.set(ws, ctx);
    log.debug("socket open", { socketId: ctx.id, ip: ctx.ip });

    ctx.authTimer = setTimeout(() => {
      if (ctx.joined) return;
      ctx.send("error", {
        code: "UNAUTHENTICATED",
        message: "No join_room message received in time",
      });
      ctx.close(WS_CLOSE.AUTH_TIMEOUT, "Authentication timeout");
    }, AUTH_TIMEOUT_MS);

    ws.on("pong", () => {
      ctx.alive = true;
    });

    // Preserve frame order for ordinary messages per socket. Filesystem
    // replies and acknowledgements must be re-entrant: the request that waits
    // for them is itself being handled by this socket, so serializing the
    // reply behind that request would deadlock until the filesystem timeout.
    let messageTail = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ctx.send("error", {
          code: "INVALID_MESSAGE",
          message: "Binary frames are not supported",
        });
        return;
      }

      const raw = data.toString();
      let type: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { type?: unknown };
        if (typeof parsed.type === "string") type = parsed.type;
      } catch {
        // The schema layer reports malformed frames consistently.
      }

      const route = () =>
        routeMessage(ctx, raw).catch((error: unknown) => {
          log.error("message routing failed", {
            socketId: ctx.id,
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
        });

      if (type === "fs_file_content" || type === "fs_ack") {
        void route();
        return;
      }

      messageTail = messageTail.then(route);
    });

    ws.on("error", (error) => {
      log.warn("socket error", { socketId: ctx.id, error: error.message });
    });

    ws.on("close", (code, reason) => {
      contexts.delete(ws);
      const remaining = (connectionsByIp.get(ctx.ip) ?? 1) - 1;
      if (remaining <= 0) connectionsByIp.delete(ctx.ip);
      else connectionsByIp.set(ctx.ip, remaining);
      if (ctx.authTimer) clearTimeout(ctx.authTimer);
      if (ctx.roomId) {
        rejectRoomRequests(ctx.roomId, "Host connection closed", ctx.id);
        publishFsCancellation(ctx.roomId, "Host connection closed", ctx.id);
      }
      void detachSocket(ctx, "dropped");
      log.debug("socket closed", {
        socketId: ctx.id,
        code,
        reason: reason.toString(),
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, ctx] of contexts) {
      if (!ctx.alive) {
        ws.terminate();
        continue;
      }
      ctx.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, WS_HEARTBEAT_MS);

  if (!sharedSinglePort) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(env.WS_PORT, "0.0.0.0", () => resolve());
    });
  }

  log.info("websocket gateway listening", {
    port: env.WS_PORT,
    mode: sharedSinglePort ? "shared" : "dedicated",
  });

  return {
    port: env.WS_PORT,
    async close() {
      clearInterval(heartbeat);
      for (const [ws, ctx] of contexts) {
        ctx.send("error", {
          code: "INTERNAL",
          message: "Server shutting down",
        });
        ctx.close(WS_CLOSE.SHUTDOWN, "Server shutting down");
        ws.terminate();
      }
      contexts.clear();
      await flushAll();
      await shutdownBus();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      if (!sharedSinglePort) {
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      }
      log.info("websocket gateway closed");
    },
  };
}
