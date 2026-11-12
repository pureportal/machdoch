import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const mediaRoles = [
  "screenshot",
  "recording",
  "reference",
  "visual",
  "video",
  "logo",
] as const;
export type MediaRole = (typeof mediaRoles)[number];
export const mediaSources = [
  "upload",
  "template",
  "composition",
  "capture",
] as const;

export const imageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const videoMimeTypes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;
export const maximumMediaBytes = 200 * 1024 * 1024;

export const visualFormats = {
  landscape: { width: 1200, height: 627, label: "Landscape · 1200×627" },
  square: { width: 1080, height: 1080, label: "Square · 1080×1080" },
  portrait: { width: 1080, height: 1350, label: "Portrait · 1080×1350" },
  wide: { width: 1920, height: 1080, label: "Wide · 1920×1080" },
} as const;
export type VisualFormat = keyof typeof visualFormats;
export const visualFormatKeys = Object.keys(visualFormats) as [
  VisualFormat,
  ...VisualFormat[],
];

export const visualTemplates = [
  "announcement",
  "spotlight",
  "highlights",
  "quote",
] as const;
export type VisualTemplate = (typeof visualTemplates)[number];

export const visualInputSchema = z.strictObject({
  template: z.enum(visualTemplates),
  format: z.enum(visualFormatKeys),
  eyebrow: z.string().trim().max(60).default(""),
  headline: z.string().trim().min(1).max(140),
  subline: z.string().trim().max(240).default(""),
  items: z.array(z.string().trim().min(1).max(90)).max(5).default([]),
  mediaId: cloudId.nullable().default(null),
  theme: z.enum(["brand", "dark", "light"]).default("brand"),
});
export type VisualInput = z.output<typeof visualInputSchema>;

export const videoFormats = ["wide", "square", "portrait"] as const;
export type VideoFormat = (typeof videoFormats)[number];

export const videoCardSchema = z.strictObject({
  enabled: z.boolean(),
  headline: z.string().trim().max(140),
  subline: z.string().trim().max(240).default(""),
  seconds: z.number().min(1).max(8),
});
export type VideoCard = z.output<typeof videoCardSchema>;

export const videoInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  format: z.enum(videoFormats),
  clips: z
    .array(
      z.strictObject({
        mediaId: cloudId,
        seconds: z.number().min(1).max(20).default(4),
        caption: z.string().trim().max(120).default(""),
      }),
    )
    .min(1)
    .max(12),
  intro: videoCardSchema,
  outro: videoCardSchema,
});
export type VideoInput = z.output<typeof videoInputSchema>;

export const mediaUploadQuerySchema = z.strictObject({
  productId: cloudId,
  releaseId: cloudId.optional(),
  name: z.string().trim().min(1).max(200),
  role: z.enum(mediaRoles),
  caption: z.string().trim().max(300).default(""),
});

export const mediaUpdateSchema = z.strictObject({
  caption: z.string().trim().max(300),
  altText: z.string().trim().max(1_000),
});

export interface ReleaseMedia {
  id: string;
  productId: string;
  releaseId: string | null;
  kind: "image" | "video";
  role: MediaRole;
  name: string;
  mime: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  caption: string;
  altText: string;
  source: (typeof mediaSources)[number];
  recipe: VisualInput | VideoInput | null;
  createdAt: string;
}

export interface MediaCapabilities {
  video: boolean;
}
