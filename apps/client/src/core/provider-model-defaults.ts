import type { ConfiguredModelProvider } from "@machdoch/model-runtime/types";
import { DEFAULT_MODEL_BY_PROVIDER } from "./runtime-contract.generated.js";
export { DEFAULT_MODEL_BY_PROVIDER } from "./runtime-contract.generated.js";
export const getDefaultModelForProvider = (
  provider: ConfiguredModelProvider,
): string => DEFAULT_MODEL_BY_PROVIDER[provider];
