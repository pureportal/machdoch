import { extname } from "node:path";
import { loadRuntimeEnvironment } from "../../core/env.js";
import { resolveAgentCliProviderBinary } from "../../core/_helpers/agent-cli-providers.js";
import { runStreamingCommand } from "../../core/_helpers/streaming-command.js";

const IMAGE_CAPABILITY_KEYS = [
  "imageInput",
  "image_input",
  "supportsImages",
  "supports_images",
  "supportsImageInput",
  "supports_image_input",
] as const;

export const parseCodexCliImageInput = (
  raw: string,
  model: string,
): boolean | undefined => {
  const payload: unknown = JSON.parse(raw);
  if (!payload || typeof payload !== "object" || !("models" in payload)) {
    return undefined;
  }

  const models = payload.models;
  if (!Array.isArray(models)) {
    return undefined;
  }

  const modelEntry: unknown = models.find(
    (entry: unknown) =>
      entry !== null &&
      typeof entry === "object" &&
      "slug" in entry &&
      typeof entry.slug === "string" &&
      entry.slug.toLowerCase() === model.trim().toLowerCase(),
  );
  if (!modelEntry || typeof modelEntry !== "object") {
    return undefined;
  }
  const capabilities = modelEntry as Record<string, unknown>;

  for (const key of IMAGE_CAPABILITY_KEYS) {
    const value = capabilities[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  for (const key of ["input_modalities", "inputModalities"] as const) {
    const value = capabilities[key];
    if (Array.isArray(value)) {
      return value.some(
        (modality: unknown) =>
          typeof modality === "string" && modality.toLowerCase() === "image",
      );
    }
  }

  return undefined;
};

export const probeCodexCliImageInput = async (
  model: string,
  workspaceRoot: string,
): Promise<boolean | undefined> => {
  try {
    const env = await loadRuntimeEnvironment();
    const binary = resolveAgentCliProviderBinary("codex-cli", env);
    if (!binary.executable) {
      return undefined;
    }

    const usesShell =
      process.platform === "win32" &&
      [".cmd", ".bat"].includes(extname(binary.executable).toLowerCase());
    if (usesShell && /[\r\n&|<>^%!]/u.test(binary.executable)) {
      return undefined;
    }

    const { stdout } = await runStreamingCommand(
      binary.executable,
      ["debug", "models"],
      {
        cwd: workspaceRoot,
        timeoutMs: 12_000,
        maxBufferBytes: 8 * 1024 * 1024,
        shell: usesShell,
      },
    );
    return parseCodexCliImageInput(stdout, model);
  } catch {
    return undefined;
  }
};
