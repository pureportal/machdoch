import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TOOLS,
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
  DEFAULT_USER_DESKTOP_SETTINGS,
  RUN_MODES,
  RUNTIME_ENV_KEYS,
  USER_WEB_SEARCH_PROVIDERS,
  VALID_MODEL_PROVIDERS,
  VALID_TOOLS,
  VALID_WEB_SEARCH_PROVIDERS,
} from "./runtime-contract.generated.js";

const contractPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../shared/runtime-config.schema.json",
);

const readRuntimeContract = () => {
  return JSON.parse(readFileSync(contractPath, "utf8")) as {
    $defs: Record<
      string,
      {
        enum?: string[];
        properties?: Record<string, { default?: unknown }>;
      }
    >;
    "x-machdoch": {
      defaultModelByProvider: Record<string, string>;
      defaultTools: string[];
      runtimeEnvKeys: string[];
    };
  };
};

const readDefaults = (
  properties: Record<string, { default?: unknown }> | undefined,
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(properties ?? {}).flatMap(([key, property]) =>
      Object.prototype.hasOwnProperty.call(property, "default")
        ? [[key, property.default]]
        : [],
    ),
  );
};

describe("generated runtime contract", () => {
  it("keeps generated TypeScript constants in sync with the shared schema", () => {
    const contract = readRuntimeContract();

    expect(RUN_MODES).toEqual(contract.$defs.RunMode?.enum);
    expect(VALID_TOOLS).toEqual(contract.$defs.ToolName?.enum);
    expect(VALID_MODEL_PROVIDERS).toEqual(
      contract.$defs.ConfiguredModelProvider?.enum,
    );
    expect(VALID_WEB_SEARCH_PROVIDERS).toEqual(
      contract.$defs.WebSearchProvider?.enum,
    );
    expect(USER_WEB_SEARCH_PROVIDERS).toEqual(
      contract.$defs.UserWebSearchProvider?.enum,
    );
    expect(DEFAULT_TOOLS).toEqual(contract["x-machdoch"].defaultTools);
    expect(DEFAULT_MODEL_BY_PROVIDER).toEqual(
      contract["x-machdoch"].defaultModelByProvider,
    );
    expect(RUNTIME_ENV_KEYS).toEqual(contract["x-machdoch"].runtimeEnvKeys);
    expect(DEFAULT_USER_AGENT_LIMITS_SETTINGS).toEqual(
      readDefaults(contract.$defs.UserAgentLimitsSettings?.properties),
    );
    expect(DEFAULT_USER_DESKTOP_SETTINGS).toEqual(
      readDefaults(contract.$defs.UserDesktopSettings?.properties),
    );
  });
});
