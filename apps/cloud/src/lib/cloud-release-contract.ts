import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";

export const socialNetworks = ["linkedin", "reddit"] as const;
export type SocialNetwork = (typeof socialNetworks)[number];
export const channelKinds = ["linkedin", "reddit", "webhook"] as const;
export type ChannelKind = (typeof channelKinds)[number];
export const channelKindLabels: Record<ChannelKind, string> = {
  linkedin: "LinkedIn",
  reddit: "Reddit",
  webhook: "Webhook",
};
export const webhookFormats = ["slack", "discord", "json"] as const;
export const channelMediaFormats = [
  "landscape",
  "square",
  "portrait",
  "wide",
  "video",
  "none",
] as const;
export type ChannelMediaFormat = (typeof channelMediaFormats)[number];
export const emojiPolicies = ["none", "light", "rich"] as const;
export const redditPostTypes = ["text", "link", "image"] as const;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color such as #6356cf.");
const httpsUrl = z.url({ protocol: /^https$/ }).max(2_000);
const hashtag = z
  .string()
  .trim()
  .regex(/^[\p{L}\p{N}_]{1,50}$/u, "Use letters, numbers and underscores.");

export const brandSchema = z.strictObject({
  primary: hexColor,
  accent: hexColor,
  background: hexColor,
  foreground: hexColor,
});
export type ProductBrand = z.output<typeof brandSchema>;

export const productVideoSchema = z.strictObject({
  introSeconds: z.number().min(0).max(8),
  outroSeconds: z.number().min(0).max(8),
});

export const productInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  key: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,39}$/,
      "Use 2–40 lowercase letters, numbers or dashes.",
    ),
  tagline: z.string().trim().max(160).default(""),
  description: z.string().trim().max(4_000).default(""),
  website: httpsUrl.nullable().default(null),
  voice: z.string().trim().max(4_000).default(""),
  audience: z.string().trim().max(1_000).default(""),
  hashtags: z.array(hashtag).max(10).default([]),
  callToAction: z.string().trim().max(200).default(""),
  brand: brandSchema,
  logoMediaId: cloudId.nullable().default(null),
  teamIds: z.array(cloudId).max(20).default([]),
  captureBrief: z.string().trim().max(8_000).default(""),
  visualStyle: z.string().trim().max(4_000).default(""),
  video: productVideoSchema.default({ introSeconds: 2.5, outroSeconds: 3 }),
  membersCanPublish: z.boolean().default(false),
});
export type ProductInput = z.output<typeof productInputSchema>;
export const productUpdateSchema = z.strictObject({
  revision,
  product: productInputSchema,
});

export interface CloudProduct extends ProductInput {
  id: string;
  revision: number;
  archived: boolean;
  channelCount: number;
  releaseCount: number;
  createdAt: string;
}

export const channelRulesSchema = z.strictObject({
  tone: z.string().trim().max(500).default(""),
  maxLength: z.number().int().min(50).max(40_000),
  hashtags: z.boolean(),
  emoji: z.enum(emojiPolicies),
  includeLink: z.boolean(),
  media: z.enum(channelMediaFormats),
  instructions: z.string().trim().max(2_000).default(""),
});
export type ChannelRules = z.output<typeof channelRulesSchema>;

export const subredditSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .transform((value) => value.replace(/^\/?r\//i, ""))
    .pipe(
      z
        .string()
        .regex(
          /^[A-Za-z0-9_]{2,21}$/,
          "Use a subreddit name such as programming.",
        ),
    ),
  flairId: z.string().trim().max(100).nullable().default(null),
  flairText: z.string().trim().max(64).nullable().default(null),
  postType: z.enum(redditPostTypes),
});
export type SubredditTarget = z.output<typeof subredditSchema>;

const channelShape = {
  name: z.string().trim().min(1).max(80),
  rules: channelRulesSchema,
  requiresApproval: z.boolean().default(true),
  enabled: z.boolean().default(true),
};

export const channelInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...channelShape,
    kind: z.literal("linkedin"),
    accountId: cloudId,
    authorUrn: z
      .string()
      .regex(
        /^urn:li:(person|organization):[A-Za-z0-9_-]{1,64}$/,
        "Choose a LinkedIn profile or page.",
      ),
    authorName: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    ...channelShape,
    kind: z.literal("reddit"),
    accountId: cloudId,
    subreddits: z
      .array(subredditSchema)
      .min(1)
      .max(10)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.name.toLowerCase())).size ===
          entries.length,
        "List each subreddit once.",
      ),
  }),
  z.strictObject({
    ...channelShape,
    kind: z.literal("webhook"),
    url: httpsUrl.nullable(),
    format: z.enum(webhookFormats),
  }),
]);
export type ChannelInput = z.output<typeof channelInputSchema>;
export const channelUpdateSchema = z.strictObject({
  revision,
  channel: channelInputSchema,
});

type ChannelView<T> = T extends { kind: "webhook" }
  ? Omit<T, "url"> & { webhookHost: string }
  : T;

export type CloudChannel = ChannelView<ChannelInput> & {
  id: string;
  productId: string;
  revision: number;
  position: number;
  accountName: string | null;
};

export const socialAppInputSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  organizationPages: z.boolean().default(false),
});

export interface SocialApp {
  network: SocialNetwork;
  configured: boolean;
  clientId: string | null;
  organizationPages: boolean;
  redirectUri: string;
}

export interface SocialAccount {
  id: string;
  network: SocialNetwork;
  name: string;
  externalId: string;
  connectedBy: string;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface SocialTarget {
  urn: string;
  name: string;
  kind: "person" | "organization";
}

export interface SubredditFlair {
  id: string;
  text: string;
}

export const releaseInputSchema = z.strictObject({
  productId: cloudId,
  version: z.string().trim().min(1).max(40),
  name: z.string().trim().max(120).default(""),
  since: z.iso.date().nullable().default(null),
  targetDate: z.iso.date().nullable().default(null),
});
export type ReleaseInput = z.output<typeof releaseInputSchema>;

export const releaseHighlightSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(600).default(""),
  issueId: cloudId.nullable().default(null),
});
export type ReleaseHighlight = z.output<typeof releaseHighlightSchema>;

export const releaseUpdateSchema = z.strictObject({
  revision,
  version: z.string().trim().min(1).max(40),
  name: z.string().trim().max(120),
  summary: z.string().trim().max(1_000),
  notes: z.string().max(40_000),
  highlights: z.array(releaseHighlightSchema).max(8),
  targetDate: z.iso.date().nullable(),
});
export type ReleaseUpdate = z.output<typeof releaseUpdateSchema>;

export const releaseItemsSchema = z.strictObject({
  revision,
  excludedIssueIds: z.array(cloudId).max(500),
});

export const postStates = [
  "draft",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
] as const;
export type PostState = (typeof postStates)[number];

export interface ReleaseDelivery {
  target: string;
  state: "pending" | "published" | "failed";
  url: string | null;
  error: string | null;
  completedAt: string | null;
}

export interface ReleasePost {
  id: string;
  releaseId: string;
  channelId: string;
  channelKind: ChannelKind;
  channelName: string;
  state: PostState;
  title: string;
  body: string;
  mediaIds: string[];
  link: string | null;
  scheduledAt: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  error: string | null;
  revision: number;
  deliveries: ReleaseDelivery[];
}

export const postUpdateSchema = z.strictObject({
  revision,
  title: z.string().trim().max(300),
  body: z.string().max(40_000),
  mediaIds: z.array(cloudId).max(9),
  link: httpsUrl.nullable(),
});

export const postStateSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve"), revision }),
  z.strictObject({ action: z.literal("reopen"), revision }),
  z.strictObject({
    action: z.literal("schedule"),
    revision,
    at: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({ action: z.literal("publish"), revision }),
  z.strictObject({ action: z.literal("retry"), revision }),
  z.strictObject({ action: z.literal("manual"), revision, url: httpsUrl }),
]);
export type PostStateChange = z.output<typeof postStateSchema>;

export const releaseLaunchSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("publish") }),
  z.strictObject({
    action: z.literal("schedule"),
    at: z.iso.datetime({ offset: true }),
  }),
]);
export type ReleaseLaunch = z.output<typeof releaseLaunchSchema>;

export interface ReleaseLaunchResult {
  launched: number;
  skipped: { channelName: string; reason: string }[];
}

export const releaseStatuses = [
  "draft",
  "review",
  "ready",
  "scheduled",
  "publishing",
  "published",
  "attention",
] as const;
export type ReleaseStatus = (typeof releaseStatuses)[number];

export interface ReleaseItem {
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  completedAt: string | null;
  included: boolean;
  pullRequests: { title: string; url: string }[];
}

export const releaseJobKinds = ["write", "video", "capture"] as const;
export type ReleaseJobKind = (typeof releaseJobKinds)[number];
export interface ReleaseJob {
  id: string;
  kind: ReleaseJobKind;
  state: "queued" | "running" | "waiting" | "succeeded" | "failed";
  detail: string;
  error: string | null;
  chatId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CloudReleaseSummary {
  id: string;
  productId: string;
  productName: string;
  productKey: string;
  brand: ProductBrand;
  version: string;
  name: string;
  status: ReleaseStatus;
  targetDate: string | null;
  nextScheduledAt: string | null;
  publishedAt: string | null;
  channels: { kind: ChannelKind; state: PostState }[];
  mediaCount: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudRelease extends CloudReleaseSummary {
  revision: number;
  archived: boolean;
  summary: string;
  notes: string;
  highlights: ReleaseHighlight[];
  since: string | null;
  posts: ReleasePost[];
  items: ReleaseItem[];
  jobs: ReleaseJob[];
  canPublish: boolean;
}

export const releaseWriteSchema = z.strictObject({
  providerId: cloudId,
  model: z.string().trim().min(1).max(200),
  scope: z.enum(["all", "notes", "posts"]),
  channelIds: z.array(cloudId).max(20).default([]),
  instructions: z.string().trim().max(2_000).default(""),
});

export const releaseCaptureSchema = z.strictObject({
  shots: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
});

export interface ReleaseCaptureBrief {
  prompt: string;
  uploadUrl: string;
  expiresAt: string;
}
