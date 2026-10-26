import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { handleApiRequest } from "./server/api";
import {
  createWebRequest,
  IncomingRequestError,
  incomingRequestUrl,
} from "./server/http-request";
import { closeRuntime, getRuntime, initializeRuntime } from "./server/runtime";
import { requestClientAddress } from "./server/network";
import { maximumRequestBodyBytes } from "./server/request-limits";
import { getPreviewHub } from "./server/previews";
import {
  closeCloudRuntime,
  getCloudRuntime,
  initializeCloudRuntime,
} from "./server/cloud/runtime";
import { createPersistentCloudRuntime } from "./server/cloud/startup";
import { validateInstallationOrigin } from "./server/cloud/installation-storage";

type Command = "dev" | "serve";

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  Object.assign(process.env, {
    NODE_ENV: command === "serve" ? "production" : "development",
  });
  const arguments_ = process.argv.slice(3);
  if (
    arguments_.length &&
    (arguments_.length !== 2 ||
      arguments_[0] !== "--import-config" ||
      !arguments_[1])
  )
    throw new Error("Usage: server.ts <dev|serve> [--import-config <path>]");
  const configPath = arguments_[1];
  if (configPath)
    process.env.MACHDOCH_CLOUD_IMPORT_CONFIG = resolve(configPath);
  await initializeCloudRuntime(createPersistentCloudRuntime);
  const runtime = await initializeRuntime();
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
  const cloud = await getCloudRuntime();
  cloud.inference.worker.start();
  cloud.authentication.mailWorker.start();
  const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const app = next({ dev: development, dir: appDirectory, hostname, port });
  await app.prepare();
  const requestHandler = app.getRequestHandler();
  const upgradeHandler = app.getUpgradeHandler();
  const server = createServer((request, response) => {
    void dispatchHttpRequest(request, response, requestHandler).catch(
      (error: unknown) => {
        if (response.destroyed) return;
        const expected = error instanceof IncomingRequestError;
        if (!expected) console.error(error);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = expected ? error.status : 500;
        const message = expected
          ? error.message
          : "machdoch.cloud is unavailable.";
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
  server.on("upgrade", async (request, socket, head) => {
    try {
      const runtime = getRuntime();
      if (!runtime.config.externalBaseUrl) {
        socket.destroy();
        return;
      }
      const previews = getPreviewHub(runtime);
      if (
        !previews.matchesHost(request) &&
        (request.headers.host ?? "").toLowerCase() !==
          new URL(runtime.config.externalBaseUrl).host.toLowerCase()
      ) {
        socket.destroy();
        return;
      }
      if (
        !(await previews.handleUpgrade(request, socket, head)) &&
        !(await runtime.gateways.handleUpgrade(request, socket, head))
      ) {
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
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      closeRuntime();
      process.exit(1);
    }, 10_000);
    deadline.unref();
    getRuntime().gateways.close();
    getRuntime().previews?.close();
    server.close(() => {
      void closeCloudRuntime()
        .then(() => {
          clearTimeout(deadline);
          closeRuntime();
          process.exit(0);
        })
        .catch((error: unknown) => {
          console.error(
            "Cloud shutdown failed",
            error instanceof Error ? error.name : "Unknown error",
          );
          closeRuntime();
          process.exit(1);
        });
    });
    server.closeIdleConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      process.stdout.write(
        `machdoch.cloud listening on http://${hostname}:${port}\n`,
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
  const previewRuntime = getRuntime();
  if (
    previewRuntime.config.externalBaseUrl &&
    (await getPreviewHub(previewRuntime).handleHttp(request, response))
  )
    return;
  const pathname = incomingRequestUrl(request.url).pathname;
  if (pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  const cloud = await getCloudRuntime();
  if (cloud.origin) previewRuntime.config.externalBaseUrl = cloud.origin;
  const requestOrigin =
    previewRuntime.config.externalBaseUrl || initialRequestOrigin(request);
  if (
    (request.headers.host ?? "").toLowerCase() !==
    new URL(requestOrigin).host.toLowerCase()
  ) {
    response.writeHead(421, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    response.end("Unknown machdoch.cloud host.");
    return;
  }
  if (pathname === "/favicon.ico") {
    response.writeHead(308, { Location: "/icon.svg" });
    response.end();
    return;
  }
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/.well-known/oauth-")
  ) {
    const runtime = getRuntime();
    const controller = new AbortController();
    const disconnected = (): void => controller.abort();
    response.once("close", disconnected);
    if (response.destroyed) controller.abort();
    try {
      await writeWebResponse(
        response,
        await handleApiRequest(
          await createWebRequest(
            request,
            requestOrigin,
            maximumRequestBodyBytes(pathname, runtime.config),
            controller.signal,
          ),
          { clientAddress: requestClientAddress(request) },
        ),
      );
    } finally {
      response.removeListener("close", disconnected);
    }
    return;
  }
  await nextHandler(request, response);
}

async function writeWebResponse(
  outgoing: ServerResponse,
  incoming: Response,
): Promise<void> {
  if (outgoing.destroyed) return;
  const body = Buffer.from(await incoming.arrayBuffer());
  if (outgoing.destroyed) return;
  for (const [name, value] of incoming.headers) {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  }
  const cookies = incoming.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
  outgoing.writeHead(incoming.status);
  outgoing.end(body);
}

function parseCommand(value: string | undefined): Command {
  if (["dev", "serve"].includes(value ?? "")) {
    return value as Command;
  }
  throw new Error("Usage: server.ts <dev|serve> [--import-config <path>]");
}

function initialRequestOrigin(request: IncomingMessage): string {
  const host = request.headers.host;
  if (!host || /[\s,/@\\]/u.test(host))
    throw new IncomingRequestError(400, "Request host is invalid.");
  const development = process.env.NODE_ENV !== "production";
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host);
  return validateInstallationOrigin(
    `${development && loopback ? "http" : "https"}://${host}`,
    development,
  );
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  closeRuntime();
  try {
    await closeCloudRuntime();
  } finally {
    process.exit(1);
  }
});
