import type { AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import type {
  InteractiveAgentSession,
  InteractiveSessionIo,
} from "./agent-interactive-session.js";
import {
  ClaudeInteractiveSession,
  type ClaudeInteractiveTurnInput,
} from "./claude-interactive-session.js";
import { ClaudeNativeGoalSession } from "./claude-native-goal.js";
import {
  CodexAppServerSession,
  type CodexAppServerTurnInput,
} from "./codex-app-server-session.js";
import {
  CodexNativeGoalSession,
  type CodexNativeGoalInput,
} from "./codex-native-goal.js";
import {
  CopilotServerSession,
  type CopilotServerTurnInput,
} from "./copilot-server-session.js";

/** The service tier id Codex lists as "Fast" in `codex debug models`. */
export const CODEX_FAST_SERVICE_TIER = "priority";

export type InteractiveCommandSpec =
  | ({ kind: "claude"; fastMode: boolean } & ClaudeInteractiveTurnInput)
  | { kind: "claude-goal"; objective: string }
  | ({ kind: "codex"; fastMode: boolean } & CodexAppServerTurnInput)
  | ({ kind: "codex-goal" } & CodexNativeGoalInput)
  | ({ kind: "copilot" } & CopilotServerTurnInput);

export const createInteractiveAgentSession = (
  spec: InteractiveCommandSpec,
  io: InteractiveSessionIo,
  publish: (state: AgentLiveState) => void,
  options: { model: string; captureEvidence: boolean; unattended: boolean },
): InteractiveAgentSession => {
  switch (spec.kind) {
    case "claude":
      return new ClaudeInteractiveSession(spec, io, publish, {
        ...options,
        fastMode: spec.fastMode,
      });
    case "claude-goal":
      return new ClaudeNativeGoalSession(spec.objective, io, publish, options);
    case "codex":
      return new CodexAppServerSession(spec, io, publish, {
        ...options,
        fastMode: spec.fastMode,
      });
    case "codex-goal":
      return new CodexNativeGoalSession(spec, io, publish, options);
    case "copilot":
      return new CopilotServerSession(spec, io, publish, options);
  }
};
