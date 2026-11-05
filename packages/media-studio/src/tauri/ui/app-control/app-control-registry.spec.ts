import { describe, expect, it, vi } from "vitest";
import {
  AppControlRegistry,
  type AppControlAction,
} from "./app-control-registry";
import { validateAppControlInput } from "./app-control-input";

const action = (
  id: string,
  run: AppControlAction["run"] = () => ({ ok: true }),
  extra: Partial<AppControlAction> = {},
): AppControlAction => ({
  id,
  description: id,
  effect: "write",
  input: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
  },
  run,
  ...extra,
});

describe("AppControlRegistry", () => {
  it("orders location, state, and workspace by level regardless of registration order", () => {
    const registry = new AppControlRegistry();
    registry.register("media", 1, () => ({
      location: ["Basic", "Image"],
      workspaceRoot: "C:/media",
      state: () => ({ prompt: "cat" }),
      actions: [action("media.set_prompt")],
    }));
    registry.register("app", 0, () => ({
      location: ["Media Studio"],
      workspaceRoot: "C:/chat",
      state: () => ({ activeView: "media" }),
      actions: [action("app.open_view")],
    }));

    expect(registry.snapshot()).toEqual({
      location: ["Media Studio", "Basic", "Image"],
      workspaceRoot: "C:/media",
      state: { app: { activeView: "media" }, media: { prompt: "cat" } },
      actions: [
        expect.objectContaining({ id: "app.open_view" }),
        expect.objectContaining({ id: "media.set_prompt" }),
      ],
    });
    expect(registry.snapshot().actions[0]).not.toHaveProperty("run");
  });

  it("keeps a re-registered view when a stale cleanup runs", () => {
    const registry = new AppControlRegistry();
    const first = registry.register("view", 1, () => ({ location: ["One"] }));
    registry.register("view", 1, () => ({ location: ["Two"] }));
    first();
    expect(registry.location()).toEqual(["Two"]);
  });

  it("replaces unreadable state with a diagnostic", () => {
    const registry = new AppControlRegistry();
    registry.register("broken", 1, () => ({
      location: [],
      state: () => {
        throw new Error("not loaded");
      },
    }));
    expect(registry.snapshot().state).toEqual({
      broken: { unavailable: "not loaded" },
    });
  });

  it("validates input and blocks write actions in ask mode", async () => {
    const registry = new AppControlRegistry();
    const run = vi.fn(() => "done");
    registry.register("app", 0, () => ({
      location: [],
      actions: [action("app.rename", run)],
    }));

    await expect(
      registry.run("app.rename", {}, { mode: "machdoch" }),
    ).rejects.toThrow('Input "name" is required.');
    await expect(
      registry.run("app.rename", { name: "x", extra: 1 }, { mode: "machdoch" }),
    ).rejects.toThrow('Unknown input "extra"');
    await expect(
      registry.run("app.rename", { name: "x" }, { mode: "ask" }),
    ).rejects.toThrow("needs Machdoch mode");
    await expect(
      registry.run("app.missing", {}, { mode: "machdoch" }),
    ).rejects.toThrow("Available actions: app.rename");
    await expect(
      registry.run("app.rename", { name: "x" }, { mode: "machdoch" }),
    ).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("aborts actions that exceed their timeout", async () => {
    vi.useFakeTimers();
    const registry = new AppControlRegistry();
    let aborted = false;
    registry.register("app", 0, () => ({
      location: [],
      actions: [
        action(
          "app.slow",
          (_input, { signal }) =>
            new Promise(() => {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
            }),
          { timeoutMs: 1_000 },
        ),
      ],
    }));
    const result = registry.run(
      "app.slow",
      { name: "x" },
      { mode: "machdoch" },
    );
    const assertion = expect(result).rejects.toThrow(
      "did not finish within 1 seconds",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });

  it("waits for a view to register", async () => {
    const registry = new AppControlRegistry();
    const waiting = registry.waitForView("media", 1_000);
    registry.register("media", 1, () => ({ location: ["Basic"] }));
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("validateAppControlInput", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 4 },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      enabled: { type: "boolean" },
    },
  } as const;

  it("accepts valid input", () => {
    expect(
      validateAppControlInput(schema, {
        count: 2,
        mode: "a",
        tags: ["x"],
        enabled: false,
      }),
    ).toBeNull();
  });

  it.each([
    [{ count: 1.5 }, "count must be an integer."],
    [{ count: 9 }, "count must be at most 4."],
    [{ mode: "c" }, 'mode must be one of "a", "b".'],
    [{ tags: ["x", 1] }, "tags[1] must be a string, not number."],
    [{ tags: ["a", "b", "c"] }, "tags must have at most 2 items."],
    [{ enabled: "yes" }, "enabled must be true or false, not string."],
  ])("rejects %j", (input, message) => {
    expect(validateAppControlInput(schema, input)).toBe(message);
  });
});
