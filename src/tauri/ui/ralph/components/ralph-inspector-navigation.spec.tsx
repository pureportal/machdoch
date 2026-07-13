import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  RalphFlowBlock,
  RalphFlowEdge,
} from "../../../../core/ralph.js";
import {
  RalphInspectorSectionTabs,
  RalphSelectedRouteSummary,
} from "./ralph-inspector-navigation";

const createBlock = (id: string, title: string): RalphFlowBlock =>
  ({
    id,
    title,
    type: "PROMPT",
  }) as RalphFlowBlock;

const createEdge = (output: string, to: string): RalphFlowEdge => ({
  id: `source-${output}-${to}`,
  from: "source",
  fromOutput: output,
  to,
});

describe("RalphInspectorSectionTabs", () => {
  it("hides when there is only one section", () => {
    const { container } = render(
      <RalphInspectorSectionTabs
        sections={[{ id: "content", label: "Content" }]}
        activeSection="content"
        missingRouteCount={0}
        onSelectSection={vi.fn()}
      />,
    );

    expect(container.textContent).toBe("");
  });

  it("renders route tabs with missing-route badges and selection callbacks", () => {
    const onSelectSection = vi.fn();

    render(
      <RalphInspectorSectionTabs
        sections={[
          { id: "content", label: "Content" },
          { id: "routes", label: "Routes" },
        ]}
        activeSection="content"
        missingRouteCount={2}
        onSelectSection={onSelectSection}
      />,
    );

    const routeButton = screen.getByRole("button", { name: /Route map/ });

    fireEvent.click(routeButton);

    expect(routeButton.textContent).toBe("Routes2");
    expect(onSelectSection).toHaveBeenCalledWith("routes");
  });
});

describe("RalphSelectedRouteSummary", () => {
  it("renders connected, missing, and unconnected route targets", () => {
    const routesByOutput = new Map<string, RalphFlowEdge>([
      ["ok", createEdge("ok", "target")],
      ["missing", createEdge("missing", "deleted")],
    ]);

    render(
      <RalphSelectedRouteSummary
        outputs={["ok", "missing", "error"]}
        routesByOutput={routesByOutput}
        blocks={[createBlock("target", "Next block")]}
        missingRouteCount={1}
        connectedRouteCount={2}
        onOpenRoutes={vi.fn()}
      />,
    );

    expect(screen.getByText("2/3 connected")).toBeTruthy();
    expect(screen.getByText(/ok/).textContent).toBe("ok -> Next block");
    expect(screen.getByText(/missing/).textContent).toBe("missing -> missing");
    expect(screen.getByText(/error/).textContent).toBe("error -> unconnected");
  });

  it("calls back when the route summary is opened", () => {
    const onOpenRoutes = vi.fn();

    render(
      <RalphSelectedRouteSummary
        outputs={["ok"]}
        routesByOutput={new Map()}
        blocks={[]}
        missingRouteCount={1}
        connectedRouteCount={0}
        onOpenRoutes={onOpenRoutes}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Route summary/ }));

    expect(onOpenRoutes).toHaveBeenCalledOnce();
  });
});
