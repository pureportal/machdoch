import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentControlEndpoint,
  AgentLiveCapability,
} from "@machdoch/fleet-protocol/task-thinking";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_STEER_CHARS = 16_000;

export class AgentControlRequestError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** What an interactive provider session can do while its turn runs. */
export interface AgentTaskControlHandlers {
  steer?(text: string): Promise<void> | void;
  interrupt?(): Promise<void> | void;
  answer?(questionId: string, answers: Record<string, string>): Promise<void> | void;
  stopTask?(taskId: string): Promise<void> | void;
}

export interface AgentTaskControlServer {
  readonly endpoint: AgentControlEndpoint;
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new AgentControlRequestError("The request body is too large.", 413);
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AgentControlRequestError("The request body is not valid JSON.", 400);
  }
};

const isAuthorized = (request: IncomingMessage, token: string): boolean => {
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const writeJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body));
};

const capabilitiesFor = (
  handlers: AgentTaskControlHandlers,
): AgentLiveCapability[] => [
  ...(handlers.steer ? (["steer"] as const) : []),
  ...(handlers.interrupt ? (["interrupt"] as const) : []),
  ...(handlers.answer ? (["answer"] as const) : []),
  ...(handlers.stopTask ? (["stop-task"] as const) : []),
];

const parseAnswers = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    throw new AgentControlRequestError("Answers must be an object.", 400);
  }
  const answers: Record<string, string> = {};
  for (const [key, answer] of Object.entries(value).slice(0, 16)) {
    if (typeof answer !== "string") {
      throw new AgentControlRequestError("Each answer must be text.", 400);
    }
    answers[key.slice(0, 200)] = answer.slice(0, 4_000);
  }
  return answers;
};

/**
 * Starts a loopback endpoint that lets the desktop UI send input into the
 * running provider turn. It lives exactly as long as the turn.
 */
export const startAgentTaskControlServer = async (
  handlers: AgentTaskControlHandlers,
): Promise<AgentTaskControlServer> => {
  const token = randomBytes(32).toString("base64url");
  const capabilities = capabilitiesFor(handlers);

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        // WebView2 asks before a page reaches a loopback address.
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }
    if (!isAuthorized(request, token)) {
      writeJson(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/v1/health") {
      writeJson(response, 200, { ok: true, capabilities });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { ok: false, error: "Use POST." });
      return;
    }
    const body = await readJsonBody(request);
    const payload = isRecord(body) ? body : {};
    switch (path) {
      case "/v1/steer": {
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!handlers.steer) throw new AgentControlRequestError("This run cannot be steered.");
        if (!text) throw new AgentControlRequestError("Enter a message to steer with.", 400);
        await handlers.steer(text.slice(0, MAX_STEER_CHARS));
        break;
      }
      case "/v1/interrupt": {
        if (!handlers.interrupt) throw new AgentControlRequestError("This run cannot be interrupted.");
        await handlers.interrupt();
        break;
      }
      case "/v1/answer": {
        const questionId =
          typeof payload.questionId === "string" ? payload.questionId : "";
        if (!handlers.answer) throw new AgentControlRequestError("This run has no question to answer.");
        if (!questionId) throw new AgentControlRequestError("Missing question id.", 400);
        await handlers.answer(questionId, parseAnswers(payload.answers));
        break;
      }
      case "/v1/tasks/stop": {
        const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
        if (!handlers.stopTask) throw new AgentControlRequestError("Background tasks cannot be stopped here.");
        if (!taskId) throw new AgentControlRequestError("Missing task id.", 400);
        await handlers.stopTask(taskId);
        break;
      }
      default:
        writeJson(response, 404, { ok: false, error: "Unknown control route." });
        return;
    }
    writeJson(response, 200, { ok: true });
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const status =
        error instanceof AgentControlRequestError ? error.status : 500;
      const message =
        error instanceof Error ? error.message : "The control request failed.";
      if (!response.headersSent) writeJson(response, status, { ok: false, error: message });
      else response.end();
    });
  });
  server.keepAliveTimeout = 2_000;
  server.requestTimeout = 15_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // A failing control connection must never take the run down with it.
  server.on("error", () => undefined);
  server.unref();
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: { url: `http://127.0.0.1:${port}`, token, capabilities },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};
