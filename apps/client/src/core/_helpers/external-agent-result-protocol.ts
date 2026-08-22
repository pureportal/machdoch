import type { TaskExecutionControl, TaskResultProtocol } from "../types.js";
import {
  createTaskResultControlOptions,
  parseTaskExecutionControl,
} from "./task-result-protocol.js";

const CONTROL_PREFIX = "<!-- MACHDOCH_CONTROL/1 ";
const CONTROL_SUFFIX = " -->";

const encodeControl = (control: TaskExecutionControl): string =>
  Buffer.from(JSON.stringify(control), "utf8").toString("base64url");

const createControlRecord = (control: TaskExecutionControl): string =>
  `${CONTROL_PREFIX}${encodeControl(control)}${CONTROL_SUFFIX}`;

const getControlLabel = (control: TaskExecutionControl): string =>
  control.kind === "ralph-route" ? control.label : control.decision;

export const createExternalAgentResultProtocolInstructions = (
  protocol: TaskResultProtocol,
): string[] => {
  const options = createTaskResultControlOptions(protocol);
  return [
    "After the user-facing answer, print exactly one Machdoch control record as the final non-empty line. Do not fence, explain, or repeat the record.",
    "Choose the record whose label matches the actual result:",
    ...options.map(
      (control) =>
        `${getControlLabel(control)}: ${createControlRecord(control)}`,
    ),
  ];
};

export interface ExternalAgentProtocolResult {
  answer: string;
  control: TaskExecutionControl;
}

export const parseExternalAgentProtocolResult = (
  output: string,
  protocol: TaskResultProtocol,
): ExternalAgentProtocolResult | undefined => {
  const lines = output.split(/\r?\n/u);
  while (lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }

  const controlLines = lines.filter((line) =>
    line.trim().startsWith(CONTROL_PREFIX),
  );
  const finalLine = lines.at(-1)?.trim();
  if (
    controlLines.length !== 1 ||
    !finalLine?.startsWith(CONTROL_PREFIX) ||
    !finalLine.endsWith(CONTROL_SUFFIX)
  ) {
    return undefined;
  }

  const encoded = finalLine.slice(
    CONTROL_PREFIX.length,
    -CONTROL_SUFFIX.length,
  );
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  const control = parseTaskExecutionControl(value, protocol);
  if (!control) {
    return undefined;
  }

  lines.pop();
  return { answer: lines.join("\n").trim(), control };
};
