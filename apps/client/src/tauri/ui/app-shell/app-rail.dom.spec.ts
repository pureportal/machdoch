// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandProvider } from "../commands/command-context";
import { TooltipProvider } from "../components/ui/tooltip";
import { AppRail, type AppActivityState } from "./app-rail";

const renderRail = (
  mediaActivity: AppActivityState,
  onOpenFleetManager = (): void => undefined,
): void => {
  const rail = createElement(AppRail, {
    activeApp: "chat",
    chatActivity: "idle",
    ralphActivity: "idle",
    mediaActivity,
    schedulerActivity: "idle",
    onSelectApp: () => undefined,
    onOpenScheduler: () => undefined,
    onOpenFleetManager,
    onOpenSettings: () => undefined,
  });

  render(
    createElement(CommandProvider, {
      activeView: "chat",
      platform: "windows",
      runtime: "browser",
      children: createElement(TooltipProvider, null, rail),
    }),
  );
};

afterEach(cleanup);

describe("AppRail Media Studio activity", () => {
  it("does not render a status indicator while Media Studio is idle", () => {
    renderRail("idle");

    const mediaStudio = screen.getByRole("button", { name: "Media Studio" });
    expect(
      mediaStudio.querySelector(":scope > span[aria-hidden='true']"),
    ).toBeNull();
  });

  it("renders a status indicator while Media Studio is running", () => {
    renderRail("running");

    const mediaStudio = screen.getByRole("button", {
      name: "Media Studio, running",
    });
    expect(
      mediaStudio.querySelector(":scope > span[aria-hidden='true']"),
    ).not.toBeNull();
  });
});

describe("AppRail Fleet Manager navigation", () => {
  it("opens Fleet Manager without exposing legacy remote access", () => {
    const onOpenFleetManager = vi.fn();
    renderRail("idle", onOpenFleetManager);

    fireEvent.click(screen.getByRole("button", { name: "Fleet Manager" }));

    expect(onOpenFleetManager).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Remote Access" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Mission Control" }),
    ).toBeNull();
  });
});
