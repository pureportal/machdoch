import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { handleApiRequest } from "./server/api";
import { loadConfig } from "./server/config";
import { nowSeconds } from "./server/database";
import {
  createWebRequest,
  IncomingRequestError,
  incomingRequestUrl,
} from "./server/http-request";
import { initializeSettingsKeyFile } from "./server/settings-crypto";
import { closeRuntime, getRuntime } from "./server/runtime";
import { requestClientAddress } from "./server/network";
import { maximumRequestBodyBytes } from "./server/request-limits";

type Command = "dev" | "serve" | "seed" | "password" | "settings-key";

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const configPath = resolve(
    optionValue(process.argv.slice(3), "--config") ?? "fleet-manager.json",
  );
  process.env.MACHDOCH_FLEET_MANAGER_CONFIG = configPath;
  const runtimeMode = command === "serve" ? "production" : "development";
  if (command === "settings-key") {
    initializeSettingsKeyFile(loadConfig(configPath, runtimeMode));
    process.stdout.write("Settings encryption key created.\n");
    return;
  }
  const runtime = getRuntime(runtimeMode);
  if (command === "seed") {
    const username = requiredEnvironment("FLEET_MANAGER_SEED_USERNAME");
    const password = requiredEnvironment("FLEET_MANAGER_SEED_PASSWORD");
    runtime.authStore.seedOwner(username, password, nowSeconds());
    process.stdout.write("Fleet Manager owner initialized.\n");
    closeRuntime();
    return;
  }
  if (command === "password") {
    const account = runtime.authStore.ownerAccount();
    const username = process.env.FLEET_MANAGER_NEW_USERNAME ?? account.username;
    const password = requiredEnvironment("FLEET_MANAGER_NEW_PASSWORD");
    runtime.authStore.changeOwnerPassword(username, password, nowSeconds());
    process.stdout.write("Fleet Manager owner updated.\n");
    closeRuntime();
    return;
  }
  if (!runtime.authStore.ownerExists()) {
    throw new Error(
      "Fleet Manager owner is not initialized. Run the seed command first.",
    );
  }
  await runServer(
    command === "dev",
    runtime.config.listen.address,
    runtime.config.listen.port,
  );
}

async function runServer(
  development: boolean,
  hostname: string,
  port: number,
): Promise<void> {
  const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const app = next({ dev: development, dir: appDirectory, hostname, port });
  await app.prepare();
  const requestHandler = app.getRequestHandler();
  const upgradeHandler = app.getUpgradeHandler();
  const server = createServer((request, response) => {
    void dispatchHttpRequest(request, response, requestHandler).catch(
      (error: unknown) => {
        const expected = error instanceof IncomingRequestError;
        if (!expected) console.error(error);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = expected ? error.status : 500;
        const message = expected
          ? error.message
          : "Fleet Manager is unavailable.";
        response.writeHead(status, {
          "Cache-Control": "no-store",
          Connection: "close",
          "Content-Security-Policy": "default-src 'none'",
          "Content-Type": "application/json; charset=utf-8",
          "Referrer-Policy": "no-referrer",
          "Strict-Transport-Security": "max-age=31536000",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        });
        response.end(JSON.stringify({ error: message }));
      },
    );
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("upgrade", (request, socket, head) => {
    try {
      if (!getRuntime().gateways.handleUpgrade(request, socket, head)) {
        void upgradeHandler(request, socket, head).catch((error: unknown) => {
          console.error(error);
          socket.destroy();
        });
      }
    } catch (error) {
      console.error(error);
      socket.destroy();
    }
  });
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    getRuntime().gateways.close();
    server.close(() => {
      closeRuntime();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      process.stdout.write(
        `Fleet Manager listening on http://${hostname}:${port}\n`,
      );
      resolveListening();
    });
  });
}

async function dispatchHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  nextHandler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): Promise<void> {
  const pathname = incomingRequestUrl(request.url).pathname;
  if (pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  if (pathname === "/favicon.ico") {
    response.writeHead(308, { Location: "/icon.svg" });
    response.end();
    return;
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const runtime = getRuntime();
    await writeWebResponse(
      response,
      await handleApiRequest(
        await createWebRequest(
          request,
          runtime.config.externalBaseUrl,
          maximumRequestBodyBytes(pathname, runtime.config),
        ),
        { clientAddress: requestClientAddress(request) },
      ),
    );
    return;
  }
  await nextHandler(request, response);
}

async function writeWebResponse(
  outgoing: ServerResponse,
  incoming: Response,
): Promise<void> {
  const body = Buffer.from(await incoming.arrayBuffer());
  for (const [name, value] of incoming.headers) {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  }
  const cookies = incoming.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
  outgoing.writeHead(incoming.status);
  outgoing.end(body);
}

function parseCommand(value: string | undefined): Command {
  if (
    ["dev", "serve", "seed", "password", "settings-key"].includes(value ?? "")
  ) {
    return value as Command;
  }
  throw new Error(
    "Usage: server.ts <dev|serve|seed|password|settings-key> [--config <path>]",
  );
}

function optionValue(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  closeRuntime();
  process.exitCode = 1;
});
