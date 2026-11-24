import { describe, expect, it } from "vitest";
import {
  agentHandoffInputSchema,
  handoffModels,
  resolveHandoff,
  type HandoffChoice,
  type HandoffOptions,
} from "./agent-handoff";

const ids = {
  sandbox: "00000000-0000-4000-8000-000000000001",
  pool: "00000000-0000-4000-8000-000000000002",
  client: "00000000-0000-4000-8000-000000000003",
  laptop: "00000000-0000-4000-8000-000000000004",
  desktop: "00000000-0000-4000-8000-000000000005",
  openai: "00000000-0000-4000-8000-000000000006",
  codex: "00000000-0000-4000-8000-000000000007",
  copilot: "00000000-0000-4000-8000-000000000008",
};

const options: HandoffOptions = {
  subject: { kind: "issue", id: ids.sandbox, label: "ENG-1" },
  profiles: [
    { id: ids.sandbox, name: "Sandbox", target: "cloud" },
    { id: ids.pool, name: "Pool", target: "client-linux" },
    { id: ids.client, name: "Devices", target: "client" },
  ],
  devices: [
    { id: ids.laptop, name: "Laptop", profileId: ids.client },
    { id: ids.desktop, name: "Desktop", profileId: ids.client },
  ],
  providers: [
    { id: ids.openai, name: "OpenAI", kind: "openai", models: ["gpt-5"] },
    { id: ids.codex, name: "Codex", kind: "codex-cli", models: ["gpt-5.5"] },
    {
      id: ids.copilot,
      name: "Copilot",
      kind: "copilot-cli",
      models: ["claude-sonnet-4.5"],
    },
  ],
};

function choice(overrides: Partial<HandoffChoice>): HandoffChoice {
  return {
    placement: "automatic",
    profileId: null,
    workerId: null,
    harness: "machdoch",
    model: "gpt-5",
    ...overrides,
  };
}

describe("agent handoff", () => {
  it("runs machdoch, Codex CLI and Copilot CLI in a cloud sandbox with the chosen model", () => {
    expect(resolveHandoff(choice({ placement: "sandbox" }), options)).toEqual({
      available: true,
      placement: "sandbox",
      profileId: ids.sandbox,
      workerId: null,
      providerId: ids.openai,
      agent: null,
      model: "gpt-5",
    });
    expect(
      resolveHandoff(
        choice({ placement: "sandbox", harness: "codex", model: "gpt-5.5" }),
        options,
      ),
    ).toMatchObject({ providerId: ids.codex, model: "gpt-5.5" });
    expect(
      resolveHandoff(
        choice({
          placement: "runner_pool",
          harness: "copilot",
          model: "claude-sonnet-4.5",
        }),
        options,
      ),
    ).toMatchObject({ profileId: ids.pool, providerId: ids.copilot });
  });

  it("pins a specific linked device and maps the harness to its agent", () => {
    expect(
      resolveHandoff(
        choice({
          placement: "client",
          workerId: ids.desktop,
          harness: "claude",
          model: "opus",
        }),
        options,
      ),
    ).toEqual({
      available: true,
      placement: "client",
      profileId: ids.client,
      workerId: ids.desktop,
      providerId: null,
      agent: "claude-cli",
      model: "opus",
    });
  });

  it("explains why a choice cannot run", () => {
    expect(
      resolveHandoff(
        choice({ placement: "client", harness: "copilot" }),
        options,
      ),
    ).toEqual({
      available: false,
      reason: "Linked client cannot run Copilot CLI.",
    });
    expect(
      resolveHandoff(
        choice({ placement: "sandbox", harness: "claude", model: "opus" }),
        options,
      ),
    ).toEqual({
      available: false,
      reason: "No Claude Code provider offers opus.",
    });
    expect(
      resolveHandoff(choice({ placement: "client" }), {
        ...options,
        devices: [],
      }),
    ).toEqual({ available: false, reason: "No linked client is online." });
    expect(
      resolveHandoff(choice({ placement: "sandbox" }), {
        ...options,
        profiles: [],
      }),
    ).toEqual({
      available: false,
      reason: "No cloud sandbox is set up for this project.",
    });
  });

  it("places automatically in sandbox, runner pool, then linked client order", () => {
    expect(resolveHandoff(choice({}), options)).toMatchObject({
      placement: "sandbox",
    });
    expect(
      resolveHandoff(choice({}), {
        ...options,
        profiles: options.profiles.slice(1),
      }),
    ).toMatchObject({ placement: "runner_pool" });
    expect(
      resolveHandoff(choice({ harness: "claude", model: "opus" }), options),
    ).toMatchObject({
      placement: "client",
      workerId: ids.laptop,
      agent: "claude-cli",
    });
    expect(
      resolveHandoff(choice({ harness: "copilot", model: "gpt-5" }), options),
    ).toEqual({
      available: false,
      reason: "No executor can run Copilot CLI with gpt-5.",
    });
  });

  it("suggests the models each harness can use", () => {
    expect(handoffModels("machdoch", options)).toEqual(["gpt-5"]);
    expect(handoffModels("codex", options)).toEqual(["gpt-5.5"]);
    expect(handoffModels("claude", options)).toEqual([]);
  });

  it("accepts a device only for linked clients and a profile only for brokered placements", () => {
    const input = {
      turnId: ids.sandbox,
      harness: "machdoch",
      model: "gpt-5",
      instructions: "Fix it",
    };
    expect(
      agentHandoffInputSchema.safeParse({
        ...input,
        placement: "client",
        profileId: null,
        workerId: ids.laptop,
      }).success,
    ).toBe(true);
    expect(
      agentHandoffInputSchema.safeParse({
        ...input,
        placement: "sandbox",
        profileId: null,
        workerId: ids.laptop,
      }).success,
    ).toBe(false);
    expect(
      agentHandoffInputSchema.safeParse({
        ...input,
        placement: "client",
        profileId: ids.client,
        workerId: null,
      }).success,
    ).toBe(false);
  });
});
