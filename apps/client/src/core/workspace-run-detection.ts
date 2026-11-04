import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadRuntimeConfig } from "./config.js";
import {
  executeInternalTaskModelInference,
  parseInternalTaskStructuredOutput,
} from "./internal-task-model.js";
import {
  collectWorkspaceRunEvidence,
  formatWorkspaceRunEvidence,
} from "./_helpers/workspace-run-detection-evidence.helper.js";
import {
  convertDetectedRunOutput,
  WORKSPACE_RUN_DETECTION_OUTPUT,
  type DetectedRunOutput,
  type WorkspaceRunDetectionResult,
} from "./_helpers/workspace-run-detection-output.helper.js";

const DETECTION_TIMEOUT_MS = 240_000;
const DETECTION_REASONING = "low";

const DETECTION_SYSTEM_PROMPT = [
  "You turn workspace evidence into run configurations for a developer tool.",
  "Use only commands, scripts, directories, ports, and URLs that the evidence supports. Never invent scripts.",
  'runType "service" is a process that keeps running until stopped (dev servers, watchers, APIs, docker compose up). runType "job" finishes on its own (install, build, test, lint, format, typecheck, codegen, migrations, seeds, deploys, releases, login helpers, cleanup).',
  "Return at most 24 configurations: the services and the jobs a developer runs regularly. When editor launch configurations exist, they are the curated list; add only important missing services. Skip trivial aliases, lifecycle hooks such as prepare or postinstall, and per-package scripts that a workspace-level command already covers.",
  "Use the package manager proven by the lockfiles and packageManager fields.",
  "workingDirectory must be '.' or one of the listed workspace directories, using forward slashes. Do not start commands with cd when workingDirectory can express it.",
  "Convert VS Code launch configurations, tasks, and compounds when present: launch and task commands become tasks, compounds become composite configurations, ${workspaceFolder} and ${workspaceFolder:name} map to workingDirectory, and terminal exit helpers such as a trailing '; ${input:launchExit}' or 'exit' are dropped. Configurations that only exist as compound members still become tasks.",
  "Turn VS Code inputs into run inputs: pickString becomes select (keep option labels only when they differ from the value), promptString becomes text, and a pickString whose two options are a flag and an empty string becomes boolean with that flag as trueValue and an empty falseValue. Reference inputs in command or environment values as ${input:id}. Only define inputs that a command references. Give an input a description only when the label alone is ambiguous.",
  "Group configurations with short human group names from the evidence, such as VS Code presentation groups without numeric prefixes or command name prefixes (for example Workspace, Docker, Database, Infra). Use null when no grouping is evident.",
  "Names are short and human readable. Ids are unique lowercase kebab-case.",
  "Composite children must be task ids. Use startOrder sequence only when one child must finish or become ready before the next starts.",
  "Mark exactly one configuration primary: the usual complete local development setup, preferring a composite of the services when several services form the application.",
  "Add ports, URLs, and health checks only when the evidence states them or the framework default is unambiguous. Jobs have no health check and hotReload false.",
  "Keep metadata terse: evidence is one short file path or script name, and uncertainFields lists only fields that genuinely need review.",
  "Return empty arrays when the workspace has nothing runnable.",
].join("\n");

export const detectWorkspaceRunConfigurations = async (
  workspaceRoot: string,
): Promise<WorkspaceRunDetectionResult> => {
  const [config, evidence] = await Promise.all([
    loadRuntimeConfig(workspaceRoot),
    collectWorkspaceRunEvidence(workspaceRoot),
  ]);
  const turn = await executeInternalTaskModelInference(
    {
      ...config,
      internalTaskModel: {
        ...config.internalTaskModel,
        reasoning: DETECTION_REASONING,
      },
    },
    {
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userPrompt: formatWorkspaceRunEvidence(evidence),
      structuredOutput: WORKSPACE_RUN_DETECTION_OUTPUT,
      signal: AbortSignal.timeout(DETECTION_TIMEOUT_MS),
    },
  );
  const output = parseInternalTaskStructuredOutput<DetectedRunOutput>(
    turn.text,
    WORKSPACE_RUN_DETECTION_OUTPUT,
  );
  return convertDetectedRunOutput(output, (workingDirectory) => {
    try {
      return statSync(resolve(workspaceRoot, workingDirectory)).isDirectory();
    } catch {
      return false;
    }
  });
};
