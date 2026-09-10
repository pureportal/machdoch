import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RalphFlowBlock, RalphRunLogger } from "../ralph.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import { resolveWorkspaceTarget } from "./agent-tools-shared.js";
import { redactLogText } from "./format-ralph-run-log-entry.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export interface RalphJsonAttemptFailure {
  attempt: number;
  stage: "parse" | "schema";
  errors: string[];
  responseChars: number;
  responseBytes: number;
  responseRedacted: boolean;
  evidencePath?: string;
  persistenceError?: string;
}

export const recordRalphJsonAttemptFailure = async (options: {
  runId: string;
  runDirectory: string | undefined;
  operationId: string | undefined;
  block: Pick<RalphFlowBlock, "id" | "type">;
  config: Pick<RuntimeConfig, "provider" | "model">;
  attempt: number;
  stage: RalphJsonAttemptFailure["stage"];
  errors: string[];
  responseText: string;
  logger: RalphRunLogger | undefined;
}): Promise<RalphJsonAttemptFailure> => {
  const responseText = redactLogText(options.responseText);
  const failure: RalphJsonAttemptFailure = {
    attempt: options.attempt,
    stage: options.stage,
    errors: options.errors.map(redactLogText),
    responseChars: options.responseText.length,
    responseBytes: Buffer.byteLength(options.responseText, "utf8"),
    responseRedacted: responseText !== options.responseText,
  };
  const metadata = {
    runId: options.runId,
    operationId: options.operationId,
    blockId: options.block.id,
    blockType: options.block.type,
    provider: options.config.provider,
    model: options.config.model,
  };

  try {
    if (!options.runDirectory) {
      throw new Error("JSON attempt evidence requires a run directory.");
    }
    await mkdir(options.runDirectory, { recursive: true });
    const target = await resolveWorkspaceTarget(
      options.runDirectory,
      join(options.runDirectory, "json-attempts", `${randomUUID()}.json`),
    );
    if (!target.insideWorkspace) {
      throw new Error(
        "JSON attempt evidence must stay inside the run directory.",
      );
    }
    await writeJsonAtomically(
      target.resolvedPath,
      {
        kind: "ralph-json-attempt",
        createdAt: new Date().toISOString(),
        ...metadata,
        ...failure,
        responseText,
      },
      { mode: 0o600 },
    );
    failure.evidencePath = target.resolvedPath;
  } catch (error) {
    failure.persistenceError = redactLogText(
      error instanceof Error ? error.message : String(error),
    );
  }

  options.logger?.trace({
    kind: "trace",
    message: "JSON attempt failed.",
    blockId: metadata.blockId,
    blockType: metadata.blockType,
    provider: metadata.provider,
    model: metadata.model,
    attempt: failure.attempt,
    details: { operationId: metadata.operationId, ...failure },
  });
  return failure;
};
