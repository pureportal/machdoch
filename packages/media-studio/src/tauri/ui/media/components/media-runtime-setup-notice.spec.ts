// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_MEDIA_RUNTIME_SETUP } from "../media-runtime-setup";
import { MediaRuntimeSetupNotice } from "./media-runtime-setup-notice";

describe("Media Studio setup notice", () => {
  it("offers one setup action and hides diagnostics until requested", () => {
    const onSetup = vi.fn();
    const props = {
      needed: true,
      supported: true,
      refreshFailed: false,
      statusUnavailable: false,
      onSetup,
      onRefresh: vi.fn(),
    };
    const { rerender } = render(
      createElement(MediaRuntimeSetupNotice, {
        ...props,
        status: EMPTY_MEDIA_RUNTIME_SETUP,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set up Media Studio" }),
    );
    expect(onSetup).toHaveBeenCalledOnce();
    rerender(
      createElement(MediaRuntimeSetupNotice, {
        ...props,
        status: {
          ...EMPTY_MEDIA_RUNTIME_SETUP,
          phase: "failed",
          message: "Check your connection, then retry setup.",
          diagnostic: "torch 2.2.2 is incompatible",
        },
      }),
    );
    expect(
      screen.getByText("Check your connection, then retry setup."),
    ).toBeTruthy();
    expect(
      screen.getByText("torch 2.2.2 is incompatible").closest("details")?.open,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(onSetup).toHaveBeenCalledTimes(2);
  });

  it("shows progress, then completion without another install action", () => {
    const props = {
      needed: false,
      supported: true,
      refreshFailed: false,
      statusUnavailable: false,
      onSetup: vi.fn(),
      onRefresh: vi.fn(),
    };
    const { rerender } = render(
      createElement(MediaRuntimeSetupNotice, {
        ...props,
        status: { ...EMPTY_MEDIA_RUNTIME_SETUP, phase: "dependencies" },
      }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Installing components",
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      createElement(MediaRuntimeSetupNotice, {
        ...props,
        status: { ...EMPTY_MEDIA_RUNTIME_SETUP, phase: "ready" },
      }),
    );
    expect(screen.getByText("Media Studio is ready")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
