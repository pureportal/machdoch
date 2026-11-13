import type { BrandShape, OrganizationBrand } from "./organization-brand";

type Rgb = readonly [number, number, number];
type Hsl = readonly [number, number, number];

export interface BrandThemeColors {
  primary: string;
  foreground: string;
  gradient: string | null;
}
export interface BrandPalette {
  dark: BrandThemeColors;
  light: BrandThemeColors;
}

const themeSurfaces = { dark: "#141519", light: "#ffffff" } as const;
const minimumContrast = 4.5;

function parseHex(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function formatHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function toHsl([red, green, blue]: Rgb): Hsl {
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, saturation, lightness];
}

function toRgb([hue, saturation, lightness]: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ][sector]!;
  return [(r! + offset) * 255, (g! + offset) * 255, (b! + offset) * 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [
    relativeLuminance(first),
    relativeLuminance(second),
  ].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

export function readableOn(color: string, surface: string): string {
  if (contrastRatio(color, surface) >= minimumContrast) return color;
  const [hue, saturation, lightness] = toHsl(parseHex(color));
  const direction = relativeLuminance(surface) > 0.5 ? -1 : 1;
  let candidate = color;
  for (
    let next = lightness;
    next >= 0 &&
    next <= 1 &&
    contrastRatio(candidate, surface) < minimumContrast;
    next += direction * 0.01
  )
    candidate = formatHex(toRgb([hue, saturation, next]));
  return candidate;
}

function foregroundFor(primary: string): string {
  const [hue, saturation] = toHsl(parseHex(primary));
  const dark = formatHex(toRgb([hue, Math.min(saturation, 0.5), 0.1]));
  return contrastRatio(primary, "#ffffff") >= contrastRatio(primary, dark)
    ? "#ffffff"
    : dark;
}

function themeColors(
  brand: Pick<OrganizationBrand, "color" | "gradient">,
  surface: string,
): BrandThemeColors {
  const primary = readableOn(brand.color, surface);
  return {
    primary,
    foreground: foregroundFor(primary),
    gradient: brand.gradient && readableOn(brand.gradient, surface),
  };
}

export function brandIdentityColors(
  brand: Pick<OrganizationBrand, "color" | "gradient">,
): BrandThemeColors {
  return {
    primary: brand.color,
    foreground: foregroundFor(brand.color),
    gradient: brand.gradient,
  };
}

export function brandPalette(
  brand: Pick<OrganizationBrand, "color" | "gradient">,
): BrandPalette {
  return {
    dark: themeColors(brand, themeSurfaces.dark),
    light: themeColors(brand, themeSurfaces.light),
  };
}

export const brandShapeRadius: Record<BrandShape, string> = {
  rounded: "28%",
  circle: "50%",
  square: "12%",
};

function themeDeclarations(colors: BrandThemeColors): string {
  const fill = colors.gradient
    ? `linear-gradient(135deg, ${colors.primary}, ${colors.gradient})`
    : colors.primary;
  return `--primary:${colors.primary};--primary-foreground:${colors.foreground};--cloud-brand-fill:${fill};`;
}

export function brandStylesheet(
  brand: Pick<OrganizationBrand, "color" | "gradient" | "shape">,
  scope: string,
): string {
  const palette = brandPalette(brand);
  const target = `body:has(${scope})`;
  return [
    `${target}{${themeDeclarations(palette.dark)}--cloud-brand-radius:${brandShapeRadius[brand.shape]};}`,
    `html[data-theme="light"] ${target}{${themeDeclarations(palette.light)}}`,
  ].join("\n");
}

export type BrandFaviconGlyph =
  | { kind: "icon"; markup: string }
  | { kind: "text"; text: string };

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

export function brandFaviconSvg({
  colors,
  shape,
  glyph,
}: {
  colors: BrandThemeColors;
  shape: BrandShape;
  glyph: BrandFaviconGlyph;
}): string {
  const radius = Number.parseFloat(brandShapeRadius[shape]) * 0.64;
  const fill = colors.gradient ? "url(#brand-fill)" : colors.primary;
  const gradient = colors.gradient
    ? `<defs><linearGradient id="brand-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.primary}"/><stop offset="1" stop-color="${colors.gradient}"/></linearGradient></defs>`
    : "";
  const content =
    glyph.kind === "icon"
      ? `<svg x="14" y="14" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${colors.foreground}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${glyph.markup}</svg>`
      : `<text x="32" y="33" dominant-baseline="central" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="${glyph.text.length > 1 ? 26 : 34}" fill="${colors.foreground}">${escapeXml(glyph.text)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${gradient}<rect width="64" height="64" rx="${radius}" fill="${fill}"/>${content}</svg>`;
}
