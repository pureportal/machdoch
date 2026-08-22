import { describe, expect, it, vi } from "vitest";
import {
  subscribeToSettingsImport,
  subscribeToSettingsTransfer,
} from "./settings-transfer.js";

describe("settings transfer subscriptions outside the desktop runtime", () => {
  it("returns inert unsubscribe callbacks without invoking Tauri internals", async () => {
    const transferListener = vi.fn();
    const importListener = vi.fn();

    const unsubscribeTransfer =
      await subscribeToSettingsTransfer(transferListener);
    const unsubscribeImport = await subscribeToSettingsImport(importListener);

    expect(unsubscribeTransfer).toBeTypeOf("function");
    expect(unsubscribeImport).toBeTypeOf("function");
    expect(() => unsubscribeTransfer()).not.toThrow();
    expect(() => unsubscribeImport()).not.toThrow();
    expect(transferListener).not.toHaveBeenCalled();
    expect(importListener).not.toHaveBeenCalled();
  });
});
