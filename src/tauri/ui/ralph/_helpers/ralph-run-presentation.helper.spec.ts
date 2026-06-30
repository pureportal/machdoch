import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileText,
  LoaderCircle,
  MessageSquare,
  Octagon,
  Sparkles,
} from "lucide-react";
import { describe, expect, it } from "vitest";

import type { ActiveRalphRun } from "./ralph-active-run-progress.helper";
import {
  getFlowRunStatusLabel,
  getFlowStatusPresentation,
  getOutputChipClassName,
  getRunStatusPresentation,
} from "./ralph-run-presentation.helper";

const createActiveRun = (
  status: ActiveRalphRun["status"],
  id = status,
): ActiveRalphRun => ({
  id,
  flowId: "flow-1",
  scope: "workspace",
  flowName: "Flow",
  startedAt: 1,
  status,
  mode: "full",
  provider: "openai",
  model: "gpt-4.1",
  variableValues: {},
  events: [],
  blockDetails: {},
});

describe("ralph-run-presentation helper", () => {
  it("formats active run labels for flow rows", () => {
    expect(getFlowRunStatusLabel([])).toBeNull();
    expect(getFlowRunStatusLabel([createActiveRun("running")])).toBe("Running");
    expect(
      getFlowRunStatusLabel([
        createActiveRun("running", "one"),
        createActiveRun("running", "two"),
      ]),
    ).toBe("2 running");
    expect(getFlowRunStatusLabel([createActiveRun("stopping")])).toBe(
      "Stopping",
    );
    expect(
      getFlowRunStatusLabel([
        createActiveRun("running", "one"),
        createActiveRun("stopping", "two"),
      ]),
    ).toBe("2 stopping");
  });

  it("maps flow status labels to icons and tones", () => {
    expect(getFlowStatusPresentation("Running")).toMatchObject({
      icon: LoaderCircle,
      className: "text-sky-200",
      spin: true,
    });
    expect(getFlowStatusPresentation("Generated")).toMatchObject({
      icon: Sparkles,
      className: "text-emerald-200",
    });
    expect(getFlowStatusPresentation("Unsaved")).toMatchObject({
      icon: FileText,
      className: "text-amber-200",
    });
    expect(getFlowStatusPresentation("Warnings")).toMatchObject({
      icon: AlertTriangle,
      className: "text-amber-200",
    });
    expect(getFlowStatusPresentation("Errors")).toMatchObject({
      icon: AlertTriangle,
      className: "text-red-200",
    });
    expect(getFlowStatusPresentation("Ready")).toMatchObject({
      icon: Check,
      className: "text-emerald-200",
    });
    expect(getFlowStatusPresentation("Saved")).toMatchObject({
      icon: CheckCircle2,
      className: "text-slate-500",
    });
  });

  it("maps run statuses to labels, icons, and chip classes", () => {
    expect(getRunStatusPresentation("running")).toMatchObject({
      label: "Running",
      icon: LoaderCircle,
      chipClassName: "border-sky-400/30 bg-sky-500/10 text-sky-100",
      spin: true,
    });
    expect(getRunStatusPresentation("stopping")).toMatchObject({
      label: "Stopping",
      icon: LoaderCircle,
      chipClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
      spin: true,
    });
    expect(getRunStatusPresentation("completed")).toMatchObject({
      label: "Completed",
      icon: CheckCircle2,
      chipClassName:
        "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
    });
    expect(getRunStatusPresentation("blocked")).toMatchObject({
      label: "Blocked",
      icon: AlertTriangle,
      chipClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
    });
    expect(getRunStatusPresentation("waiting-for-input")).toMatchObject({
      label: "Waiting for input",
      icon: MessageSquare,
      chipClassName: "border-teal-400/30 bg-teal-500/10 text-teal-100",
    });
    expect(getRunStatusPresentation("crashed")).toMatchObject({
      label: "Crashed",
      icon: Octagon,
      chipClassName: "border-rose-400/30 bg-rose-500/10 text-rose-100",
    });
    expect(getRunStatusPresentation("stopped")).toMatchObject({
      label: "Stopped",
      icon: Octagon,
      chipClassName: "border-slate-700 bg-slate-900 text-slate-300",
    });
  });

  it("maps block output names to stable chip classes", () => {
    expect(getOutputChipClassName(undefined)).toBe(
      "border-slate-800 bg-slate-950 text-slate-500",
    );
    expect(getOutputChipClassName("SUCCESS")).toBe(
      "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
    );
    expect(getOutputChipClassName("ERROR")).toBe(
      "border-rose-400/30 bg-rose-500/10 text-rose-100",
    );
    expect(getOutputChipClassName("RETRY")).toBe(
      "border-amber-400/30 bg-amber-500/10 text-amber-100",
    );
    expect(getOutputChipClassName("CUSTOM")).toBe(
      "border-sky-400/30 bg-sky-500/10 text-sky-100",
    );
  });
});
