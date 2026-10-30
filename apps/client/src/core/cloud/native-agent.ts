import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RunManifest } from "@machdoch/fleet-protocol/cloud-execution";
import {
  readStopReceipt,
  type StopReceipt,
} from "@machdoch/cloud-client/stop-receipt";
import { resolveMachdochCliLaunch } from "../provider-enrollment/machdoch-cli-launch.js";
import {
  processIsRunning,
  runBoundedProcess,
  stopProcessTree,
  taskEnvironment,
} from "./native-process.js";

export interface NativeAgentResult {
  status: "executed" | "failed";
  summary: string;
  tokens: number;
}

const agentOutputSchema = z.object({
  execution: z.object({
    status: z.string(),
    summary: z.string(),
    reason: z.string().optional(),
    metadata: z
      .object({
        modelUsage: z
          .object({
            totals: z.object({ totalTokens: z.number().optional() }),
          })
          .optional(),
      })
      .optional(),
  }),
});
const processRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
});

export function nativeAgentTask(
  manifest: Pick<
    RunManifest,
    "title" | "objective" | "acceptanceCriteria" | "profile"
  >,
  feedback = "",
): string {
  return [
    `# ${manifest.title}`,
    manifest.objective,
    `## Acceptance criteria\n${manifest.acceptanceCriteria}`,
    `## Required checks\n${manifest.profile.requiredChecks.map((check) => `- ${check.name}: \`${check.command}\``).join("\n")}`,
    ...(feedback ? [`## Failed verification\n${feedback}`] : []),
    "Implement the change in this checkout and run the required checks. Leave the result in the working tree. Do not push, open pull requests, or change other repositories.",
  ].join("\n\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function receiptPath(directory: string, environmentId: string): string {
  return join(directory, `${environmentId}.stopped.json`);
}

async function writeReceipt(
  directory: string,
  receipt: StopReceipt,
): Promise<StopReceipt> {
  await writeFile(
    receiptPath(directory, receipt.environmentId),
    JSON.stringify(receipt),
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

export async function reconcileNativeEnvironment(
  directory: string,
  environmentId: string,
): Promise<void> {
  if (
    await readStopReceipt(receiptPath(directory, environmentId), environmentId)
  )
    return;
  let pid: number | null = null;
  try {
    pid = processRecordSchema.parse(
      JSON.parse(
        await readFile(
          join(directory, `${environmentId}.process.json`),
          "utf8",
        ),
      ),
    ).pid;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (pid !== null && processIsRunning(pid)) stopProcessTree(pid);
  await writeReceipt(directory, {
    version: 1,
    environmentId,
    supervisorPid: process.pid,
    childPid: pid,
    exitCode: null,
    reason: "parent_closed",
    processTreeStopped: true,
  });
}

export async function runNativeAgent(options: {
  agent: "machdoch" | "codex-cli" | "claude-cli";
  model: string | undefined;
  task: string;
  workingDirectory: string;
  stateDirectory: string;
  environmentId: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<{ result: NativeAgentResult; receipt: StopReceipt }> {
  const launch = resolveMachdochCliLaunch();
  const outcome = await runBoundedProcess({
    command: launch.command,
    args: [
      ...launch.args,
      "run",
      "--task",
      "-",
      "--cwd",
      options.workingDirectory,
      "--mode",
      "machdoch",
      "--json",
      ...(options.agent === "machdoch"
        ? []
        : ["--runtime-provider", options.agent]),
      ...(options.model ? ["--model", options.model] : []),
    ],
    cwd: options.workingDirectory,
    env: taskEnvironment(launch.environment),
    input: options.task,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    outputLimitBytes: 8 * 1024 * 1024,
    onSpawn: (pid) =>
      writeFile(
        join(options.stateDirectory, `${options.environmentId}.process.json`),
        JSON.stringify({ pid }),
        { flag: "wx", mode: 0o600 },
      ),
  });
  const receipt = await writeReceipt(options.stateDirectory, {
    version: 1,
    environmentId: options.environmentId,
    supervisorPid: process.pid,
    childPid: outcome.pid,
    exitCode: outcome.exitCode,
    reason: outcome.aborted
      ? "canceled"
      : outcome.timedOut
        ? "lease_expired"
        : "completed",
    processTreeStopped: true,
  });
  if (outcome.aborted) options.signal.throwIfAborted();
  if (outcome.timedOut)
    return {
      receipt,
      result: {
        status: "failed",
        summary: "The agent reached the task time limit.",
        tokens: 0,
      },
    };
  const parsed = agentOutputSchema.safeParse(parseJson(outcome.stdout));
  if (!parsed.success)
    return {
      receipt,
      result: {
        status: "failed",
        summary:
          outcome.stderr
            .trim()
            .split("\n")
            .slice(-20)
            .join("\n")
            .slice(-4000) || "The agent stopped without a result.",
        tokens: 0,
      },
    };
  const execution = parsed.data.execution;
  return {
    receipt,
    result: {
      status: execution.status === "executed" ? "executed" : "failed",
      summary: (
        execution.summary ||
        execution.reason ||
        "The agent finished."
      ).slice(0, 15000),
      tokens: Math.max(
        0,
        Math.trunc(execution.metadata?.modelUsage?.totals.totalTokens ?? 0),
      ),
    },
  };
}
