import { createHash, randomBytes } from "node:crypto";
import { fileTool } from "./file-tools.ts";
import { runShell } from "./shell.ts";
import { prepareRepository, repositoryResponse } from "./repository.ts";
import { snapshotCandidate, freezeRepository } from "./candidate.ts";
import { agentInferenceReply, runSharedAgent } from "./shared-agent.ts";
import { GuestProcessStopError } from "./process-group.ts";
import { prepareLocalRepository } from "./local-repository.ts";

const uid = process.getuid?.();
if (process.platform !== "linux" || uid !== 0)
  throw new Error("The guest controller requires its dedicated account.");

const tools = {
  run_agent: {
    execute: (input: Record<string, unknown>, id: string) =>
      runSharedAgent(id, input, emit),
    keys: ["start", "directory"],
  },
  read_file: {
    execute: (input: Record<string, unknown>) => fileTool("read_file", input),
    keys: ["path", "offset", "limit", "encoding"],
  },
  write_file: {
    execute: (input: Record<string, unknown>) => fileTool("write_file", input),
    keys: ["path", "content"],
  },
  list_files: {
    execute: (input: Record<string, unknown>) => fileTool("list_files", input),
    keys: ["path", "offset"],
  },
  export_artifact: {
    execute: (input: Record<string, unknown>) =>
      fileTool("export_artifact", input),
    keys: ["path", "offset", "limit"],
  },
  describe_artifact: {
    execute: (input: Record<string, unknown>) =>
      fileTool("describe_artifact", input),
    keys: ["path"],
  },
  write_artifact: {
    execute: (input: Record<string, unknown>) =>
      fileTool("write_artifact", input),
    keys: ["path", "offset", "content"],
  },
  shell: { execute: runShell, keys: ["command", "directory", "timeoutMs"] },
  snapshot_candidate: { execute: snapshotCandidate, keys: ["baseCommit"] },
  freeze_repository: { execute: freezeRepository, keys: [] as string[] },
  prepare_repository: {
    execute: (input: Record<string, unknown>) => prepareRepository(input, emit),
    keys: ["commit"],
  },
  prepare_local_repository: {
    execute: prepareLocalRepository,
    keys: ["commit"],
  },
};
type ToolName = keyof typeof tools;
interface ToolRequest {
  id: string;
  tool: ToolName;
  arguments: Record<string, unknown>;
}
type ToolResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
interface Receipt {
  digest: string;
  response?: ToolResponse;
}
const receipts = new Map<string, Receipt>();
let pending: (Receipt & { id: string }) | undefined;
let buffer: Buffer = Buffer.alloc(0);
function emit(
  value:
    | ToolResponse
    | {
        kind: "ready";
        version: number;
        node: string;
        controllerUid: number;
        toolUid: number;
      }
    | Record<string, unknown>,
) {
  if (process.stdout.writableLength > 1024 * 1024) process.exit(2);
  process.stdout.write(`\x1e${JSON.stringify(value)}\n`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRequest(bytes: Buffer): ToolRequest {
  let request: unknown;
  try {
    request = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON request");
  }
  if (
    !isRecord(request) ||
    typeof request.id !== "string" ||
    !/^[-0-9a-f]{36}$/.test(request.id) ||
    typeof request.tool !== "string" ||
    !Object.hasOwn(tools, request.tool) ||
    !isRecord(request.arguments) ||
    Object.keys(request).some(
      (key) => !["id", "tool", "arguments"].includes(key),
    )
  )
    throw new Error("Invalid tool request");
  return {
    id: request.id,
    tool: request.tool as ToolName,
    arguments: request.arguments,
  };
}
async function dispatch(bytes: Buffer) {
  const frame: unknown = JSON.parse(bytes.toString("utf8"));
  if (isRecord(frame) && frame.kind === "repository_response") {
    await repositoryResponse(frame);
    return;
  }
  if (isRecord(frame) && frame.kind === "agent_inference_reply") {
    agentInferenceReply(frame);
    return;
  }
  const request = parseRequest(bytes);
  const tool = tools[request.tool];
  if (
    Object.entries(request.arguments).some(
      ([key, value]) =>
        !tool.keys.includes(key) ||
        !["string", "number"].includes(typeof value),
    )
  ) {
    emit({
      id: request.id,
      ok: false,
      error: "Tool arguments must use the documented fields and types",
    });
    return;
  }
  const normalized = {
    tool: request.tool,
    arguments: Object.fromEntries(
      Object.keys(request.arguments)
        .sort()
        .map((key) => [key, request.arguments[key]]),
    ),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const previous =
    receipts.get(request.id) ??
    (pending?.id === request.id ? pending : undefined);
  if (previous) {
    if (previous.digest !== digest)
      emit({
        id: request.id,
        ok: false,
        error: "Request ID was reused with different arguments",
      });
    else if (previous.response) emit(previous.response);
    return;
  }
  if (pending) {
    emit({ id: request.id, ok: false, error: "A tool is already running" });
    return;
  }
  const transfer = [
    "export_artifact",
    "describe_artifact",
    "write_artifact",
  ].includes(request.tool);
  if (!transfer && receipts.size >= 512) {
    emit({
      id: request.id,
      ok: false,
      error: "The environment reached its tool limit",
    });
    return;
  }
  pending = { id: request.id, digest };
  let response: ToolResponse;
  try {
    response = {
      id: request.id,
      ok: true,
      result: await tool.execute(request.arguments, request.id),
    };
  } catch (error) {
    if (error instanceof GuestProcessStopError) throw error;
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Tool failed",
    };
  }
  if (!transfer) receipts.set(request.id, { digest, response });
  pending = undefined;
  emit(response);
}
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 1024 * 1024) process.exit(2);
  let end;
  while ((end = buffer.indexOf(10)) >= 0) {
    const message = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    void dispatch(message).catch(() => process.exit(2));
  }
});
process.stdin.on("end", () => {
  process.exit(2);
});
process.stdin.on("error", () => process.exit(2));
randomBytes(1);
emit({
  kind: "ready",
  version: 6,
  node: process.version,
  controllerUid: uid,
  toolUid: 1000,
});
