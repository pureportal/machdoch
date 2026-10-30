import { AgentLiveTracker } from "./agent-live-tracker.js";
import type {
  InteractiveAgentSession,
  InteractiveSessionIo,
} from "./agent-interactive-session.js";
import { ClaudeLiveEventReader } from "./claude-live-events.js";
import {
  ClaudeCliOutputDecoder,
  type ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";

/**
 * Runs Claude Code's own `/goal` loop in one invocation. The loop reads no
 * further input, so the run is observed but not steered.
 */
export class ClaudeNativeGoalSession
  extends ClaudeCliOutputDecoder
  implements InteractiveAgentSession
{
  readonly live: AgentLiveTracker;
  readonly controls = {};
  private readonly events: ClaudeLiveEventReader;

  constructor(
    private readonly objective: string,
    private readonly io: InteractiveSessionIo,
    publish: ConstructorParameters<typeof AgentLiveTracker>[1],
    options: { model: string; captureEvidence: boolean },
  ) {
    // A goal turn outlasts its first result while background jobs run.
    super(options.captureEvidence, true);
    this.live = new AgentLiveTracker(
      {
        provider: "claude-cli",
        transport: "stream-json",
        capabilities: [],
        model: options.model,
      },
      publish,
    );
    this.events = new ClaudeLiveEventReader(this.live);
  }

  start(): void {
    this.io.write(`/goal ${this.objective}`);
    this.io.closeInput();
    this.live.flush();
  }

  interrupt(): boolean {
    return false;
  }

  dispose(): void {
    this.live.close();
  }

  protected override processEvent(
    event: Record<string, unknown>,
    update: ExternalAgentCliOutputUpdate,
  ): void {
    super.processEvent(event, update);
    switch (event.type) {
      case "rate_limit_event":
        this.events.rateLimit(event);
        break;
      case "system":
        this.events.system(event);
        break;
      case "assistant":
        this.events.assistant(event);
        break;
      case "user":
        this.events.toolResults(event);
        break;
      case "result":
        this.events.result(event, this.getUsage());
        break;
    }
  }
}
