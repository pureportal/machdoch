import { expect, it } from "vitest";
import studentManifests from "../../../../../apps/client/src-tauri/src/media/student_model_manifests.json" with { type: "json" };
import { studentModelSetup } from "./student-model-setup.js";
import { createOpenMediaModels } from "./open-model-profiles.js";

it("downloads both SDXL students as complete packages without teacher UNet weights", () => {
  for (const manifest of studentManifests) {
    const model = createOpenMediaModels("test").find(
      (model) => model.id === manifest.modelId,
    )!;
    const setup = studentModelSetup(model.architecture)!;
    expect(model.management.acquisition).toBe("managed-install");
    expect(
      manifest.files.some(
        (file) =>
          file.path.startsWith("unet/") && file.path !== "unet/config.json",
      ),
    ).toBe(false);
    expect(
      manifest.files.filter((file) => file.path.startsWith("distillation/")),
    ).toEqual([expect.objectContaining({ downloadUrl: setup.checkpointUrl })]);
    for (const path of setup.requiredPaths) {
      expect(
        manifest.files.some((file) =>
          path.endsWith("/") ? file.path.startsWith(path) : file.path === path,
        ),
      ).toBe(true);
    }
    for (const file of manifest.files) {
      expect(file.downloadUrl).toMatch(
        /^https:\/\/huggingface\.co\/.+\/resolve\/[a-f0-9]{40}\//u,
      );
    }
  }
});

it.each(["minimax-h3-pdmd-2step", "minimax-h3-pdmd-4step"])(
  "links the released %s adapter while specifying its renamed import path",
  (architecture) => {
    const setup = studentModelSetup(architecture)!;
    expect(setup.checkpointUrl).toMatch(/\/lora_model_0\.safetensors$/u);
    expect(setup.baseUrl).toBe("https://huggingface.co/MiniMaxAI/MiniMax-H3");
    expect(setup.requiredPaths).toContain(
      architecture.endsWith("2step")
        ? "distillation/pdmd_2nfe.safetensors"
        : "distillation/pdmd_4nfe.safetensors",
    );
    expect(setup.requiredPaths).toContain("text_encoder/");
  },
);

it("offers no student setup for an ordinary SDXL or Ref2VA model", () => {
  expect(studentModelSetup("stable-diffusion-xl")).toBeNull();
  expect(studentModelSetup("minimax-h3-ref2va")).toBeNull();
});
