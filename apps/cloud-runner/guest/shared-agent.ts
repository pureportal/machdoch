import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stopGuestWorkload } from "./process-group.ts";
import { commandDirectory } from "./files.ts";

interface AgentSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  requests: Set<string>;
  fail: (error: Error) => void;
}
let session: AgentSession | undefined;
let used = false;

export function agentInferenceReply(message: Record<string, unknown>): void {
  const current = session;
  const reply = message.reply;
  if (
    !current ||
    message.operationId !== current.id ||
    !reply ||
    typeof reply !== "object" ||
    Array.isArray(reply)
  )
    throw new Error("The inference reply belongs to another agent operation");
  const response = reply as Record<string, unknown>;
  if (
    typeof response.requestId !== "string" ||
    !current.requests.delete(response.requestId)
  )
    throw new Error("The inference reply belongs to another request");
  const bytes = JSON.stringify(reply) + "\n";
  if (
    Buffer.byteLength(bytes) > 512 * 1024 ||
    current.child.stdin.writableLength > 512 * 1024
  )
    throw new Error("Agent input exceeds its limit");
  current.child.stdin.write(bytes, (error) => {
    if (error) current.fail(error);
  });
}

export async function runSharedAgent(
  id: string,
  input: Record<string, unknown>,
  emit: (message: Record<string, unknown>) => void,
) {
  if (
    used ||
    typeof input.start !== "string" ||
    Buffer.byteLength(input.start) > 128 * 1024
  )
    throw new Error("This environment cannot start another agent");
  const start = JSON.parse(input.start) as Record<string, unknown>;
  if (
    !start ||
    start.kind !== "start" ||
    typeof start.durationMs !== "number" ||
    !Number.isSafeInteger(start.durationMs) ||
    start.durationMs < 1 ||
    start.durationMs > 86400000
  )
    throw new Error("Invalid agent execution limit");
  used = true;
  await stopGuestWorkload();
  const cwd = await commandDirectory(input.directory);
  const child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "/opt/machdoch/exec.py",
      "/usr/bin/node",
      "/opt/machdoch/shared-agent.cjs",
    ],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/run",
        MACHDOCH_USER_CONFIG_DIR: "/run",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "true",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    },
  );
  let stderr = "",
    buffer = Buffer.alloc(0),
    frames = 0;
  let complete: { status: string; summary: string } | undefined;
  let failure: Error | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fail = (error: Error) => {
    failure ??= error;
    finish();
  };
  const current: AgentSession = { id, child, requests: new Set(), fail };
  session = current;
  const timer = setTimeout(
    () => fail(new Error("The shared agent exceeded its execution limit")),
    start.durationMs,
  );
  child.stdin.on("error", fail);
  child.once("error", fail);
  child.once("exit", () => {
    if (!complete)
      fail(
        new Error(stderr.trim() || "The shared agent ended without a result"),
      );
    else finish();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString("utf8")).slice(-8192);
  });
  child.stdout.on("data", (bytes: Buffer) => {
    if (failure) return;
    try {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > 512 * 1024)
        throw new Error("Agent output exceeds its limit");
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (++frames > 10000 || complete)
          throw new Error("Unexpected agent output");
        const message = JSON.parse(
          buffer.subarray(0, end).toString("utf8"),
        ) as Record<string, unknown>;
        buffer = buffer.subarray(end + 1);
        if (
          message.kind === "progress" &&
          typeof message.state === "string" &&
          message.state.length <= 128
        )
          continue;
        if (
          message.kind === "complete" &&
          typeof message.status === "string" &&
          typeof message.summary === "string" &&
          message.summary.length <= 8192
        ) {
          if (current.requests.size)
            throw new Error("Agent completed with outstanding inference");
          complete = { status: message.status, summary: message.summary };
          finish();
          continue;
        }
        const request = message.request as Record<string, unknown> | undefined;
        if (
          message.kind !== "inference" ||
          !request ||
          typeof request.requestId !== "string" ||
          !/^[a-f0-9-]{36}$/u.test(request.requestId) ||
          current.requests.size >= 16 ||
          current.requests.has(request.requestId)
        )
          throw new Error("Invalid agent inference output");
        current.requests.add(request.requestId);
        emit({ kind: "agent_inference", operationId: id, request });
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Invalid agent output"));
    }
  });
  child.stdin.write(input.start + "\n");
  try {
    await finished;
  } finally {
    clearTimeout(timer);
    session = undefined;
    await stopGuestWorkload();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  return {
    status: !failure && complete?.status === "executed" ? "executed" : "failed",
    summary:
      failure?.message ??
      complete?.summary ??
      "The shared agent did not finish",
    processTreeStopped: true,
  };
}
