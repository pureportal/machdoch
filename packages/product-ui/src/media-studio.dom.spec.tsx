import type { ProductMedia } from "@machdoch/fleet-protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaStudio } from "./media-studio";

function mediaSnapshot(): ProductMedia {
  return {
    loading: false,
    busy: false,
    generation: {
      prompt: "Snapshot prompt",
      target: "image",
      modelId: "first",
      aspectRatio: "1:1",
      outputCount: 1,
      outputFormat: "png",
      transparentBackground: false,
      available: true,
    },
    models: ["first", "second"].map((id) => ({
      id,
      label: id,
      target: "local",
      targets: ["image", "svg"],
      recommended: false,
    })),
    assets: [],
    assetCount: 0,
    runs: [],
    runCount: 0,
    updatedAt: 1,
  };
}

function harness(initial = mediaSnapshot()) {
  const onCommand = vi.fn().mockResolvedValue(true);
  const element = (media: ProductMedia) => (
    <MediaStudio media={media} pending={false} onCommand={onCommand} />
  );
  const view = render(element(initial));
  return { show: (media: ProductMedia) => view.rerender(element(media)), onCommand };
}

function displayedDraft() {
  return {
    prompt: screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt" }).value,
    target: screen.getByRole("button", { name: "SVG" }).getAttribute("aria-pressed") === "true" ? "svg" : "image",
    modelId: screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).value,
    aspectRatio: screen.getByRole<HTMLSelectElement>("combobox", { name: "Aspect ratio" }).value,
    outputCount: Number(screen.getByRole<HTMLSelectElement>("combobox", { name: "Outputs" }).value),
    outputFormat: screen.queryByRole<HTMLSelectElement>("combobox", { name: "Format" })?.value ?? "svg",
    transparentBackground: screen.getByRole<HTMLInputElement>("checkbox", { name: "Transparent background" }).checked,
  };
}

function editDraft(target: "image" | "svg" = "image") {
  fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
    target: { value: "Unsent prompt\nwith details" },
  });
  fireEvent.click(screen.getByRole("button", { name: target === "svg" ? "SVG" : "Image" }));
  const controls: [string, string][] = [["Model", "second"], ["Aspect ratio", "16:9"], ["Outputs", "4"]];
  if (target === "image") controls.push(["Format", "webp"]);
  for (const [name, value] of controls) {
    fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
  }
  fireEvent.click(screen.getByRole("checkbox", { name: "Transparent background" }));
  const expected = {
    prompt: "Unsent prompt\nwith details",
    target,
    modelId: "second",
    aspectRatio: "16:9",
    outputCount: 4,
    outputFormat: target === "svg" ? "svg" : "webp",
    transparentBackground: true,
  };
  expect(displayedDraft()).toEqual(expected);
  return expected;
}

afterEach(cleanup);

describe("media generation snapshot reconciliation", () => {
  it("populates all initial inputs", () => {
    const initial = mediaSnapshot();
    harness(initial);
    const { available: _available, ...inputs } = initial.generation;
    expect(displayedDraft()).toEqual(inputs);
  });

  it.each((["image", "svg"] as const).flatMap((target) => [
    { target, available: true, metadata: { available: false }, transition: "available to unavailable" },
    { target, available: false, metadata: { available: true }, transition: "unavailable to available" },
    { target, available: false, metadata: { available: false, unavailableReason: "Provider reconnecting" }, transition: "reason only" },
  ]))("preserves every edited $target field across $transition", ({ target, available, metadata }) => {
    const initial = mediaSnapshot();
    initial.generation.available = available;
    const view = harness(initial);
    const expected = editDraft(target);
    view.show({ ...initial, generation: { ...initial.generation, ...metadata } });
    expect(displayedDraft()).toEqual(expected);
  });

  it("preserves edits across repeated equivalent snapshots", () => {
    const initial = mediaSnapshot();
    const view = harness(initial);
    const expected = editDraft();
    for (let updatedAt = 2; updatedAt < 5; updatedAt += 1) {
      view.show({ ...structuredClone(initial), updatedAt });
      expect(displayedDraft()).toEqual(expected);
    }
  });

  it("updates unavailable controls and reasons while retaining the draft through recovery", () => {
    const initial = mediaSnapshot();
    const view = harness(initial);
    const expected = editDraft();
    for (const unavailableReason of ["Provider disconnected", "Provider reconnecting"]) {
      view.show({ ...initial, models: [], generation: { ...initial.generation, available: false, unavailableReason } });
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Generate" }).disabled).toBe(true);
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).disabled).toBe(true);
      expect(screen.getByText(unavailableReason)).toBeTruthy();
      expect(displayedDraft()).toEqual({ ...expected, modelId: "" });
    }
    expect(screen.queryByText("Provider disconnected")).toBeNull();
    view.show(structuredClone(initial));
    expect(displayedDraft()).toEqual(expected);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Generate" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).disabled).toBe(false);
    expect(screen.queryByText("Provider reconnecting")).toBeNull();
  });

  it.each([
    { prompt: "Upstream prompt" },
    { target: "svg" as const, outputFormat: "svg" as const },
    { modelId: "second" },
    { aspectRatio: "4:5" as const },
    { outputCount: 2 },
    { outputFormat: "jpeg" as const },
    { transparentBackground: true },
  ])("replaces the whole draft when upstream inputs change: %j", (change) => {
    const initial = mediaSnapshot();
    const view = harness(initial);
    editDraft();
    const next = { ...initial, generation: { ...initial.generation, ...change } };
    view.show(next);
    const { available: _available, ...inputs } = next.generation;
    expect(displayedDraft()).toEqual(inputs);
  });

  it.each(["image", "svg"] as const)("submits the displayed %s draft after metadata changes", (target) => {
    const initial = mediaSnapshot();
    const view = harness(initial);
    const expected = editDraft(target);
    view.show({ ...initial, generation: { ...initial.generation, available: false, unavailableReason: "Reconnecting" } });
    view.show(structuredClone(initial));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(view.onCommand).toHaveBeenCalledTimes(1);
    expect(view.onCommand).toHaveBeenCalledWith({ kind: "generate-media", ...expected });
    expect(view.onCommand).toHaveBeenCalledWith({ kind: "generate-media", ...displayedDraft() });
  });
});
