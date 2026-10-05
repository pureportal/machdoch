import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  managedSettingsDocumentSchema,
  type FleetManagedSettingsDocument,
} from "@machdoch/fleet-protocol";
import { loadWorkspaceConfigFile } from "./config.js";
import {
  discoverCustomizations,
  getUserPromptDirectory,
} from "./customizations.js";
import { loadUserConfigFile } from "./env.js";
import { loadInstructionLibrary } from "./instruction-system/library-store.js";

export async function exportFleetLocalSettings(
  workspaceRoot: string,
): Promise<FleetManagedSettingsDocument> {
  const [{ config }, { config: user }, library, customizations] =
    await Promise.all([
      loadWorkspaceConfigFile(workspaceRoot),
      loadUserConfigFile(),
      loadInstructionLibrary(),
      discoverCustomizations(workspaceRoot, {
        discoverUserCustomizations: true,
        discoverFleetManagedPrompts: false,
      }),
    ]);
  const prompts = await Promise.all(
    customizations.prompts
      .filter(
        (prompt) =>
          prompt.scope === "user" && !prompt.path.startsWith("fleet:"),
      )
      .map(async (prompt) => ({
        id: randomUUID(),
        relativePath: relative(
          getUserPromptDirectory(),
          prompt.path,
        ).replaceAll("\\", "/"),
        content: await readFile(prompt.path, "utf8"),
      })),
  );
  return managedSettingsDocumentSchema.parse({
    defaults: {
      provider: config.provider ?? null,
      model: config.provider ? (config.model ?? null) : null,
      mode: config.defaultMode ?? null,
      reasoning: config.reasoning ?? null,
      webSearchProvider: user.webSearch?.activeProvider ?? null,
      theme: null,
      density: null,
      accent: null,
    },
    agentLimits: {
      infinite: user.agentLimits?.infinite ?? null,
      executorTurns: user.agentLimits?.executorTurns ?? null,
      autopilotExecutorIterations:
        user.agentLimits?.autopilotExecutorIterations ?? null,
    },
    instructions: library.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      body: profile.body,
      enabled: profile.enabled,
      global: profile.global,
      tags: profile.tags,
    })),
    contextPacks: [],
    prompts,
  });
}
