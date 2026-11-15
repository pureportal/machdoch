// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

function renderOpenTooltip(): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { defaultOpen: true },
          createElement(TooltipTrigger, null, "Context size"),
          createElement(TooltipContent, null, "Workspace Default"),
        ),
      ),
    ),
  );
  return root;
}

function stubHover(available: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === "(hover: none)" && !available }) as MediaQueryList,
  );
}

const content = () => document.querySelector('[data-slot="tooltip-content"]');

describe("Tooltip", () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes by itself on touch screens", () => {
    stubHover(false);
    root = renderOpenTooltip();
    expect(content()).not.toBeNull();

    act(() => vi.advanceTimersByTime(1500));

    expect(content()).toBeNull();
  });

  it("stays open while a pointer can hover", () => {
    stubHover(true);
    root = renderOpenTooltip();

    act(() => vi.advanceTimersByTime(5000));

    expect(content()).not.toBeNull();
  });
});
