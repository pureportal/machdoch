import { z } from "zod";
const revision = z.number().int().min(1).max(2_147_483_646);

export const cloudApiProviders = [
  "openai",
  "anthropic",
  "google",
  "langdock",
] as const;
export const cloudCliProviders = ["claude-code-cli", "codex-cli"] as const;
export const cloudProviderKinds = [
  ...cloudApiProviders,
  ...cloudCliProviders,
] as const;
export type CloudApiProvider = (typeof cloudApiProviders)[number];
export type CloudCliProvider = (typeof cloudCliProviders)[number];
export type CloudProviderKind = (typeof cloudProviderKinds)[number];
export function isCloudCliProvider(
  provider: CloudProviderKind,
): provider is CloudCliProvider {
  return (cloudCliProviders as readonly string[]).includes(provider);
}
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
  .refine(
    (value) => !value.includes("://") && !value.split("/").includes(".."),
    "Enter a model identifier, not a URL or path traversal.",
  );
const providerConfiguration = z.strictObject({
  name: z.string().trim().min(1).max(120),
  models: z
    .array(modelId)
    .min(1)
    .max(50)
    .refine(
      (models) => new Set(models).size === models.length,
      "Model identifiers must be unique.",
    ),
  maxOutputTokens: z.number().int().min(64).max(65_536),
  dailyTokenBudget: z.number().int().min(1000).max(100_000_000),
  maxConcurrentRequests: z.number().int().min(1).max(32),
});
export const providerInputSchema = providerConfiguration
  .extend({
    provider: z.enum(cloudProviderKinds),
    region: z.enum(["eu", "us"]).nullable(),
    apiKey: z.string().trim().max(8192),
  })
  .refine(
    (input) => (input.provider === "langdock") === (input.region !== null),
    { path: ["region"], message: "Select a region only for Langdock." },
  )
  .refine(
    (input) => isCloudCliProvider(input.provider) || input.apiKey.length > 0,
    { path: ["apiKey"], message: "Enter an API key." },
  );
export const providerUpdateSchema = providerConfiguration.extend({
  revision,
  enabled: z.boolean(),
  region: z.enum(["eu", "us"]).nullable(),
  apiKey: z.string().trim().max(8192).optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
export interface CloudAiProvider extends z.infer<typeof providerConfiguration> {
  id: string;
  provider: CloudProviderKind;
  region: "eu" | "us" | null;
  revision: number;
  inferenceRevision: number;
  enabled: boolean;
}
export interface CloudProviderSettings {
  providers: CloudAiProvider[];
  credentialStorageAvailable: boolean;
}
