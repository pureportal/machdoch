import type { AgentToolDefinition } from "./agent-tools-shared.js";
import { createActionPackageToolDefinitions } from "./package-tool-definitions/action-package-tools.js";
import { createReadPackageToolDefinitions } from "./package-tool-definitions/read-package-tools.js";

export const createPackageToolDefinitions = (): AgentToolDefinition[] => {
  return [
    ...createReadPackageToolDefinitions(),
    ...createActionPackageToolDefinitions(),
  ];
};
