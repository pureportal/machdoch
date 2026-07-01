import { createServer, type Server } from "node:http";

const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 300_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface McpOAuthLoopbackCallbackServer {
  redirectUrl: string;
  waitForCallback: () => Promise<string>;
  close: () => Promise<void>;
}

interface McpOAuthLoopbackOptions {
  expectedState?: string;
  timeoutMs?: number;
}

interface NodeListenError extends Error {
  code?: string;
}

const isLoopbackHost = (hostname: string): boolean => {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
};

const normalizeListenHost = (hostname: string): string => {
  return hostname.toLowerCase() === "[::1]" ? "::1" : hostname;
};

const normalizeOptionalCallbackParam = (value: string | null): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

export const isMcpOAuthLoopbackRedirectUrl = (redirectUrl: string): boolean => {
  try {
    const parsedUrl = new URL(redirectUrl);
    return parsedUrl.protocol === "http:" && isLoopbackHost(parsedUrl.hostname);
  } catch {
    return false;
  }
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const renderCallbackPage = (title: string, message: string): string => {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.5; color: #0f172a; }
      main { max-width: 42rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
};

export const createMcpOAuthLoopbackCallbackServer = async (
  redirectUrl: string,
  options: McpOAuthLoopbackOptions = {},
): Promise<McpOAuthLoopbackCallbackServer> => {
  const expectedUrl = new URL(redirectUrl);

  if (!isMcpOAuthLoopbackRedirectUrl(redirectUrl)) {
    throw new Error(
      "Automatic MCP OAuth callbacks require an http://localhost, http://127.0.0.1, or http://[::1] redirect URL.",
    );
  }

  const port = Number.parseInt(expectedUrl.port || "80", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid MCP OAuth callback port in redirect URL: ${redirectUrl}`);
  }

  const listenHost = normalizeListenHost(expectedUrl.hostname);
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveCallback: ((callbackUrl: string) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;

  const callbackPromise = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  callbackPromise.catch(() => undefined);

  const server = createServer((request, response) => {
    const callbackUrl = new URL(request.url ?? "/", expectedUrl.origin);
    const callbackState = normalizeOptionalCallbackParam(
      callbackUrl.searchParams.get("state"),
    );

    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }

    if (callbackUrl.pathname !== expectedUrl.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (options.expectedState && callbackState !== options.expectedState) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderCallbackPage(
          "Authorization state mismatch",
          "Machdoch ignored this OAuth callback because its state did not match the active authorization flow.",
        ),
      );
      return;
    }

    if (settled) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderCallbackPage(
          "Authorization already received",
          "Machdoch has already received this OAuth callback. You may close this window.",
        ),
      );
      return;
    }

    const authorizationError = normalizeOptionalCallbackParam(
      callbackUrl.searchParams.get("error"),
    );
    const authorizationErrorDescription = normalizeOptionalCallbackParam(
      callbackUrl.searchParams.get("error_description"),
    );
    const authorizationCode = normalizeOptionalCallbackParam(
      callbackUrl.searchParams.get("code"),
    );

    if (authorizationError) {
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderCallbackPage(
          "Authorization failed",
          "Machdoch received an OAuth error from the authorization server. You may close this window.",
        ),
      );
      rejectCallback?.(
        new Error(
          `MCP OAuth authorization failed: ${
            authorizationErrorDescription
              ? `${authorizationError}: ${authorizationErrorDescription}`
              : authorizationError
          }`,
        ),
      );
      return;
    }

    if (!authorizationCode) {
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderCallbackPage(
          "Authorization callback invalid",
          "Machdoch received an OAuth callback without an authorization code. You may close this window.",
        ),
      );
      rejectCallback?.(
        new Error("OAuth callback URL does not contain a code parameter."),
      );
      return;
    }

    settled = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      renderCallbackPage(
        "Authorization received",
        "Machdoch received the OAuth callback and is finishing authorization. You may close this window.",
      ),
    );
    resolveCallback?.(callbackUrl.href);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      const listenError = error as NodeListenError;

      if (listenError.code === "EADDRINUSE") {
        reject(
          new Error(
            `MCP OAuth callback listener could not start because ${expectedUrl.hostname}:${port} is already in use. Close the other authorization flow or configure this MCP server with a different OAuth redirectUrl port.`,
          ),
        );
        return;
      }

      reject(error);
    };

    server.once("error", handleError);
    server.listen(port, listenHost, () => {
      server.off("error", handleError);
      resolve();
    });
  });

  timeout = setTimeout(() => {
    if (settled) {
      return;
    }

    settled = true;
    rejectCallback?.(
      new Error(
        `Timed out waiting for MCP OAuth callback after ${Math.round(timeoutMs / 1000)} seconds.`,
      ),
    );
    void closeServer(server);
  }, timeoutMs);

  return {
    redirectUrl: expectedUrl.href,
    waitForCallback: () => callbackPromise,
    close: async () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      await closeServer(server);
    },
  };
};
