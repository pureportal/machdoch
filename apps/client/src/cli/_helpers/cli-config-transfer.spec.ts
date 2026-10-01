import { describe, expect, it, vi } from "vitest";
import { runConfigTransfer } from "./cli-config-transfer.js";
import type { InteractivePrompter } from "./cli-prompter.js";
import type { SettingsTransferCategory } from "../../shared/settings-transfer.js";

const category = {
  id: "preferences.agent-provider",
  label: "Agent preferences",
  defaultSelected: true,
  availability: "available",
  effect: "replace",
  itemCount: 3,
} as SettingsTransferCategory;
const idle = {
  phase: "idle",
  categories: [category],
  networkInterfaces: [],
  discoveredSessions: [],
};
const prompter = (
  selections: (string | undefined)[],
  values: string[] = [],
): InteractivePrompter => ({
  select: vi.fn(async () => selections.shift()),
  input: vi.fn(async () => values.shift()),
  status: vi.fn(),
  suspend: async (action) => await action(),
  close: vi.fn(),
});

describe("CLI settings transfer", () => {
  it("requires import review and cancels the inspected payload on dismissal", async () => {
    const ui = prompter(
      ["import", "__continue", "cancel", undefined],
      ["settings.machdoch-settings", "test passphrase"],
    );
    const request = vi.fn(async (_action: string, setting = "") =>
      setting === "inspect"
        ? { token: "review-token", categories: [category] }
        : idle,
    );
    await runConfigTransfer(ui, "C:/workspace", request);
    expect(request.mock.calls.some((call) => call[1] === "commit")).toBe(false);
    expect(request.mock.calls.some((call) => call[1] === "cancel")).toBe(true);
    expect(ui.select).toHaveBeenCalledWith(
      "Replace local settings?",
      expect.any(Array),
      expect.objectContaining({ hint: "Agent preferences: 3 incoming items" }),
    );
  });

  it("commits only the reviewed token after accepting replacement", async () => {
    const ui = prompter(
      ["import", "__continue", "apply", undefined],
      ["settings.machdoch-settings", "test passphrase"],
    );
    const request = vi.fn(
      async (_action: string, setting = "", _value?: unknown) =>
        setting === "inspect"
          ? { token: "review-token", categories: [category] }
          : idle,
    );
    await runConfigTransfer(ui, "C:/workspace", request);
    expect(request).toHaveBeenCalledWith("transfer", "commit", {
      token: "review-token",
    });
  });

  it("rejects mismatched export passphrases without exporting", async () => {
    const ui = prompter(
      ["export", "__continue", undefined],
      [
        "new-settings.machdoch-settings",
        "test passphrase",
        "different passphrase",
      ],
    );
    const request = vi.fn(async () => idle);
    await runConfigTransfer(ui, "C:/workspace", request);
    expect(request).not.toHaveBeenCalledWith(
      "transfer",
      "export",
      expect.anything(),
    );
    expect(ui.status).toHaveBeenCalledWith(
      "Passphrases do not match. Try again.",
      "error",
    );
  });

  it("stops pairing when the user rejects the code", async () => {
    const ui = prompter(["pair", "no", undefined]);
    const request = vi.fn(async () => ({
      ...idle,
      phase: "pairing",
      pairingCode: "123456",
    }));
    await runConfigTransfer(ui, "C:/workspace", request);
    expect(request).toHaveBeenCalledWith("transfer", "stop");
    expect(request).not.toHaveBeenCalledWith("transfer", "pair");
  });
});
