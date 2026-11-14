import * as nextEnvModule from "@next/env";
import next from "next";
import { createServer } from "node:http";
import { createLogger } from "./logger";
import { handleLegacyHttpApi } from "./http-api";

// @next/env ships a bundled CommonJS namespace; Node's ESM loader exposes it
// under `default` rather than as static named exports.
const envModule = nextEnvModule as unknown as {
  default?: typeof nextEnvModule;
};
const { loadEnvConfig } = envModule.default ?? nextEnvModule;

const log = createLogger({ scope: "server" });

function banner(port: number, wsPort: number): void {
  const lines = [
    "",
    "  ██████╗ ██████╗ ██████╗ ███████╗███████╗██╗   ██╗███╗   ██╗ ██████╗",
    "  ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝╚██╗ ██╔╝████╗  ██║██╔════╝",
    "  ██║     ██║   ██║██║  ██║█████╗  ███████╗ ╚████╔╝ ██╔██╗ ██║██║     ",
    "  ██║     ██║   ██║██║  ██║██╔══╝  ╚════██║  ╚██╔╝  ██║╚██╗██║██║     ",
    "  ╚██████╗╚██████╔╝██████╔╝███████╗███████║   ██║   ██║ ╚████║╚██████╗",
    "   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝",
    "",
    `  app   http://localhost:${port}`,
    `  ws    ws://localhost:${wsPort}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

  // Imported after loadEnvConfig so .env values are visible.
  const { getEnv } = await import("@/lib/env");
  const { startGateway } = await import("./ws/server");
  const { startRoomSweeper } = await import("./rooms/lifecycle");
  const { closeRedis } = await import("@/lib/redis");

  const env = getEnv();
  const dev = env.NODE_ENV !== "production";
  const app = next({ dev, hostname: "0.0.0.0", port: env.PORT });
  await app.prepare();

  const handle = app.getRequestHandler();
  const nextServer = createServer((req, res) => {
    // The API layer uses this server-controlled value for rate limiting.
    // Overwrite any client-supplied value before Next.js builds the Request.
    req.headers["x-codesync-client-ip"] = req.socket.remoteAddress ?? "unknown";
    void handleLegacyHttpApi(req)
      .then(async (response) => {
        if (!response) {
          handle(req, res).catch((error: unknown) => {
            log.error("request failed", { url: req.url, error: String(error) });
            if (!res.headersSent) {
              res.writeHead(500, { "content-type": "text/plain" });
            }
            res.end("Internal server error");
          });
          return;
        }
        const body = Buffer.from(await response.arrayBuffer());
        const headers = Object.fromEntries(response.headers.entries());
        res.writeHead(response.status, headers);
        res.end(body);
      })
      .catch((error: unknown) => {
        log.error("legacy API request failed", {
          url: req.url,
          error: String(error),
        });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: "The request could not be completed",
            code: "INTERNAL",
          }),
        );
      });
  });

  await new Promise<void>((resolve, reject) => {
    nextServer.once("error", reject);
    nextServer.listen(env.PORT, "0.0.0.0", () => resolve());
  });

  const gateway = await startGateway(nextServer);
  const stopSweeper = startRoomSweeper();
  banner(env.PORT, gateway.port);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown requested", { signal });
    try {
      stopSweeper();
      await gateway.close();
      nextServer.closeAllConnections?.();
      await new Promise<void>((resolve) => nextServer.close(() => resolve()));
      await closeRedis();
    } catch (error) {
      log.error("shutdown error", { error: String(error) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: String(reason) });
  });
}

main().catch((error: unknown) => {
  console.error("[codesync] failed to start:", error);
  process.exit(1);
});
