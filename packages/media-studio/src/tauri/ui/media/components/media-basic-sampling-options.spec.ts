// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import { DEFAULT_MEDIA_STUDIO_STATE } from "../media-studio-store.js";
import { MediaBasicSamplingOptions } from "./media-basic-sampling-options.js";

afterEach(cleanup);

it("selects random or fixed seeds for Basic image generation", () => {
  const model = createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: true,
  }).models.find((candidate) => candidate.id === "local:flux-2-klein-4b")!;
  const onChange = vi.fn();
  const props = {
    target: "image" as const,
    settings: DEFAULT_MEDIA_STUDIO_STATE.recipe,
    videoSettings: DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
    model,
    onChange,
    onVideoChange: vi.fn(),
  };
  const { rerender } = render(createElement(MediaBasicSamplingOptions, props));

  expect(
    (screen.getByRole("combobox", { name: "Seed" }) as HTMLSelectElement).value,
  ).toBe("random");
  expect(screen.queryByRole("spinbutton", { name: "Value" })).toBeNull();

  fireEvent.change(screen.getByRole("combobox", { name: "Seed" }), {
    target: { value: "fixed" },
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ seed: 0 }),
  );

  rerender(
    createElement(MediaBasicSamplingOptions, {
      ...props,
      settings: { ...props.settings, seed: 0 },
    }),
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Value" }), {
    target: { value: "42" },
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ seed: 42 }),
  );

  fireEvent.change(screen.getByRole("combobox", { name: "Seed" }), {
    target: { value: "random" },
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ seed: null }),
  );
});
