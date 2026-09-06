// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SettingsNavigationGuardProvider,
  useSettingsNavigationGuard,
  type SettingsNavigationGuardState,
} from "./navigation-guard";

afterEach(cleanup);

const Guard = (props: SettingsNavigationGuardState & { dirty: boolean }) => {
  useSettingsNavigationGuard(props);
  return null;
};

describe("Settings navigation guards", () => {
  it("keeps unfinished fields protected when a different field becomes clean", async () => {
    const onGuardChange = vi.fn();
    const discardFirst = vi.fn();
    const discardSecond = vi.fn();
    const view = (firstDirty: boolean) =>
      createElement(SettingsNavigationGuardProvider, {
        onGuardChange,
        children: [
          createElement(Guard, {
            key: "first",
            dirty: firstDirty,
            title: "First",
            description: "First change",
            onDiscard: discardFirst,
          }),
          createElement(Guard, {
            key: "second",
            dirty: true,
            title: "Second",
            description: "Second change",
            onDiscard: discardSecond,
          }),
        ],
      });
    const { rerender } = render(view(true));
    rerender(view(false));
    const guard = onGuardChange.mock
      .lastCall?.[0] as SettingsNavigationGuardState;
    expect(guard.title).toBe("Second");
    await guard.onDiscard();
    expect(discardFirst).not.toHaveBeenCalled();
    expect(discardSecond).toHaveBeenCalledOnce();
  });

  it("waits for active saves and discards all remaining edits together", async () => {
    const onGuardChange = vi.fn();
    const discard = [vi.fn(), vi.fn()];
    const view = (saving: boolean) =>
      createElement(SettingsNavigationGuardProvider, {
        onGuardChange,
        children: discard.map((onDiscard, index) =>
          createElement(Guard, {
            key: index,
            dirty: true,
            title: `Change ${index}`,
            description: "Unsaved change",
            canDiscard: index === 0 ? !saving : true,
            onDiscard,
          }),
        ),
      });
    const { rerender } = render(view(true));
    expect(onGuardChange.mock.lastCall?.[0].canDiscard).toBe(false);
    rerender(view(false));
    const guard = onGuardChange.mock
      .lastCall?.[0] as SettingsNavigationGuardState;
    expect(guard.canDiscard).toBe(true);
    await guard.onDiscard();
    for (const onDiscard of discard) expect(onDiscard).toHaveBeenCalledOnce();
  });
});
