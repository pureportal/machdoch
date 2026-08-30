// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CommandProvider } from "../commands/command-context";
import { TooltipProvider } from "../components/ui/tooltip";
import { AppRail, type AppActivityState } from "./app-rail";

const renderRail = (mediaActivity: AppActivityState): void => {
  const rail = createElement(AppRail, {
    activeApp: "chat",
    chatActivity: "idle",
    ralphActivity: "idle",
    mediaActivity,
    schedulerActivity: "idle",
    onSelectApp: () => undefined,
    onOpenScheduler: () => undefined,
    onOpenMissionControl: () => undefined,
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
