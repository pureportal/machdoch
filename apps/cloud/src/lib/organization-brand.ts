import { z } from "zod";
import { hexColor } from "./cloud-contract";

export const brandIcons = [
  "command",
  "sparkles",
  "rocket",
  "zap",
  "layers",
  "hexagon",
  "box",
  "compass",
  "globe",
  "leaf",
  "flame",
  "mountain",
  "star",
  "heart",
  "shield",
  "cpu",
  "code",
  "feather",
  "anchor",
  "atom",
  "gem",
  "sun",
  "moon",
  "waves",
  "infinity",
  "bird",
  "orbit",
  "target",
  "crown",
  "puzzle",
  "aperture",
  "telescope",
] as const;
export type BrandIcon = (typeof brandIcons)[number];

export const brandMarkKinds = ["icon", "initials", "image"] as const;
export type BrandMarkKind = (typeof brandMarkKinds)[number];

export const brandShapes = ["rounded", "circle", "square"] as const;
export type BrandShape = (typeof brandShapes)[number];

export const brandColorPresets = [
  { name: "Sky", color: "#7bc8ef" },
  { name: "Blue", color: "#6ea8fe" },
  { name: "Violet", color: "#a79bff" },
  { name: "Pink", color: "#f39ad6" },
  { name: "Rose", color: "#f59db3" },
  { name: "Orange", color: "#f5a46c" },
  { name: "Amber", color: "#e9c074" },
  { name: "Lime", color: "#b5d86a" },
  { name: "Emerald", color: "#73d7b1" },
  { name: "Teal", color: "#5fd0d6" },
  { name: "Slate", color: "#a6aec4" },
] as const;

export const maximumBrandLogoLength = 60_000;

const brandInitials = z
  .string()
  .trim()
  .max(2)
  .regex(/^[\p{L}\p{N}]*$/u, "Use letters or numbers.")
  .transform((value) => value.toUpperCase());

export const organizationBrandSchema = z.strictObject({
  color: hexColor.transform((value) => value.toLowerCase()),
  gradient: hexColor.transform((value) => value.toLowerCase()).nullable(),
  mark: z.enum(brandMarkKinds),
  icon: z.enum(brandIcons),
  initials: brandInitials,
  shape: z.enum(brandShapes),
  tintedSidebar: z.boolean(),
  signIn: z.boolean(),
});
export type OrganizationBrand = z.infer<typeof organizationBrandSchema>;

export const defaultOrganizationBrand: OrganizationBrand = {
  color: "#7bc8ef",
  gradient: null,
  mark: "icon",
  icon: "command",
  initials: "",
  shape: "rounded",
  tintedSidebar: false,
  signIn: false,
};

const logoSignatures: Record<string, (bytes: Uint8Array) => boolean> = {
  png: (bytes) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    ),
  jpeg: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  webp: (bytes) =>
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP",
};

export function isBrandLogo(value: string): boolean {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) return false;
  let header: string;
  try {
    header = atob(match[2]!.slice(0, 16));
  } catch {
    return false;
  }
  const bytes = Uint8Array.from(header, (character) => character.charCodeAt(0));
  return logoSignatures[match[1]!]!(bytes);
}

export const brandLogoSchema = z
  .string()
  .max(maximumBrandLogoLength, "Choose a smaller image.")
  .refine(isBrandLogo, "Upload a PNG, JPEG, WebP or SVG image.");

export function organizationInitials(name: string, custom = ""): string {
  if (custom) return custom.toUpperCase();
  const words = name
    .trim()
    .split(/[\s\-_.]+/u)
    .filter(Boolean);
  const parts =
    words.length === 1 ? words[0]!.split(/(?<=\p{Ll})(?=\p{Lu})/u) : words;
  return parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();
}
