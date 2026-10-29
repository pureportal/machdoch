import type { AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import type {
  InteractiveAgentSession,
  InteractiveSessionIo,
} from "./agent-interactive-session.js";
import { ClaudeInteractiveSession } from "./claude-interactive-session.js";
import {
  CodexAppServerSession,
  type CodexAppServerTurnInput,
} from "./codex-app-server-session.js";
import {
  CopilotServerSession,
  type CopilotServerTurnInput,
} from "./copilot-server-session.js";

/** The service tier id Codex lists as "Fast" in `codex debug models`. */
export const CODEX_FAST_SERVICE_TIER = "priority";

export type InteractiveCommandSpec =
  | { kind: "claude"; prompt: string; fastMode: boolean }
  | ({ kind: "codex"; fastMode: boolean } & CodexAppServerTurnInput)
  | ({ kind: "copilot" } & CopilotServerTurnInput);

export const createInteractiveAgentSession = (
  spec: InteractiveCommandSpec,
  io: InteractiveSessionIo,
  publish: (state: AgentLiveState) => void,
  options: { model: string; captureEvidence: boolean; unattended: boolean },
): InteractiveAgentSession => {
  switch (spec.kind) {
    case "claude":
      return new ClaudeInteractiveSession(spec.prompt, io, publish, {
        ...options,
        fastMode: spec.fastMode,
      });
    case "codex":
      return new CodexAppServerSession(spec, io, publish, {
        ...options,
        fastMode: spec.fastMode,
      });
    case "copilot":
      return new CopilotServerSession(spec, io, publish, options);
  }
};
