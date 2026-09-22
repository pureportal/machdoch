import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import { describeMediaModelReadiness } from "./model-readiness.js";

describe("managed video and SVG models", () => {
  const catalog = createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
  });

  it.each([
    ["local:wan2.2-ti2v-5b", "image-to-video"],
    ["local-svg:IntroSVG-Qwen2.5-VL-7B", "text-to-svg"],
  ])(
    "directs users to model browsing before generation for %s",
    (id, capability) => {
      const model = catalog.models.find((entry) => entry.id === id)!;
      expect(model.capabilities).toContain(capability);
      expect(model.capabilities).not.toContain("text-to-image");
      expect(model.management).toEqual({
        acquisition: "managed-install",
        verification: "model-probe",
      });
      expect(model.installed).toBe(false);
      expect(describeMediaModelReadiness(model)?.action).toBe(
        "Browse Civitai to find a model.",
      );
    },
  );
});
