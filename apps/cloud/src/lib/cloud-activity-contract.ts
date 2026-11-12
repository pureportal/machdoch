import { z } from "zod";
import { revision } from "./cloud-contract";

export const aiActivityKinds = [
  "agent",
  "model",
  "task",
  "step",
  "client",
] as const;
export type AiActivityKind = (typeof aiActivityKinds)[number];
export const aiActivityStatuses = [
  "info",
  "started",
  "succeeded",
  "failed",
  "canceled",
  "warning",
] as const;
export type AiActivityStatus = (typeof aiActivityStatuses)[number];
export const aiActivityFilters = [
  "all",
  "agent",
  "tasks",
  "model",
  "clients",
] as const;
export type AiActivityFilter = (typeof aiActivityFilters)[number];
export const aiActivityQuerySchema = z.strictObject({
  filter: z.enum(aiActivityFilters).default("all"),
  problems: z.enum(["true", "false"]).default("false"),
  runId: z.uuid().optional(),
  clientId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  before: z.coerce.number().int().min(1).optional(),
});
export type AiActivityQuery = z.output<typeof aiActivityQuerySchema>;

export interface AiActivityEntry {
  id: string;
  sequence: number;
  kind: AiActivityKind;
  status: AiActivityStatus;
  title: string;
  detail: string;
  occurredAt: string;
  actorName: string;
  model: string | null;
  provider: string | null;
  tokens: number | null;
  durationMs: number | null;
  run: { id: string; title: string } | null;
  issue: { id: string; identifier: string } | null;
  chatId: string | null;
  client: { id: string; name: string } | null;
}

export interface MimoriiDelivery {
  url: string;
  enabled: boolean;
  deliveredAt: string | null;
  pending: number;
  failing: boolean;
}

export interface AiActivityFeed {
  entries: AiActivityEntry[];
  before: number | null;
  mimorii: MimoriiDelivery | null;
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const mimoriiUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(300)
  .transform((value) => new URL(value))
  .refine(
    (url) => !url.username && !url.password && !url.search && !url.hash,
    "Enter the Mimorii address without credentials or query parameters.",
  )
  .refine(
    (url) => url.protocol === "https:" || loopbackHosts.has(url.hostname),
    "Use an HTTPS address. HTTP is only available for this computer.",
  )
  .transform((url) => `${url.origin}${url.pathname.replace(/\/+$/, "")}`);

export const mimoriiSettingsInputSchema = z.strictObject({
  revision: z.number().int().min(0).max(2_147_483_646),
  url: mimoriiUrlSchema,
  token: z
    .string()
    .trim()
    .regex(
      /^mim_log_[A-Za-z0-9_-]{16,200}$/,
      "Enter a Mimorii log source token.",
    )
    .optional(),
  enabled: z.boolean(),
});
export type MimoriiSettingsInput = z.infer<typeof mimoriiSettingsInputSchema>;
export const mimoriiRemovalSchema = z.strictObject({ revision });

export interface MimoriiSettings {
  url: string;
  tokenPrefix: string;
  enabled: boolean;
  revision: number;
  connectedAt: string;
  deliveredAt: string | null;
  deliveredEntries: number;
  rejectedEntries: number;
  lastError: string | null;
  retryAt: string | null;
  pending: number;
}

export interface MimoriiAdministration {
  settings: MimoriiSettings | null;
  credentialStorageAvailable: boolean;
}

export const mimoriiLogQuery = '{service="machdoch-cloud"}';

export function mimoriiLogsUrl(url: string): string {
  return `${url}/app/monitoring/logs?query=${encodeURIComponent(mimoriiLogQuery)}`;
}
