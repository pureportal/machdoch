import { readFile } from "node:fs/promises";
import { createElement as h, type CSSProperties, type ReactNode } from "react";
import { ImageResponse } from "next/og.js";
import {
  visualFormats,
  type VisualInput,
} from "../../../lib/cloud-release-media-contract";
import type { ProductBrand } from "../../../lib/cloud-release-contract";

type FontWeight = 400 | 600 | 700;
let fonts: Promise<
  { name: string; data: ArrayBuffer; weight: FontWeight }[]
> | null = null;

function loadFonts() {
  fonts ??= Promise.all(
    (
      [
        ["Geist-Regular.ttf", 400],
        ["Geist-SemiBold.ttf", 600],
        ["Geist-Bold.ttf", 700],
      ] as const
    ).map(async ([file, weight]) => {
      const data = await readFile(new URL(`./fonts/${file}`, import.meta.url));
      return {
        name: "Geist",
        data: data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer,
        weight,
      };
    }),
  );
  return fonts;
}

export interface VisualContext {
  product: {
    name: string;
    tagline: string;
    website: string | null;
    brand: ProductBrand;
  };
  version: string;
  logo: { bytes: Buffer; mime: string } | null;
  image: { bytes: Buffer; mime: string } | null;
}

interface Palette {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  accent: string;
  primary: string;
  glow: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function alpha(hex: string, opacity: number): string {
  const [red, green, blue] = hexToRgb(hex);
  return `rgba(${red},${green},${blue},${opacity})`;
}

function palette(theme: VisualInput["theme"], brand: ProductBrand): Palette {
  if (theme === "dark")
    return {
      background: "#0c0d11",
      surface: "#16171d",
      foreground: "#f4f4f7",
      muted: "#a2a3b3",
      accent: brand.accent,
      primary: brand.primary,
      glow: alpha(brand.primary, 0.42),
    };
  if (theme === "light")
    return {
      background: "#f7f7fa",
      surface: "#ffffff",
      foreground: "#15161c",
      muted: "#5d5e6c",
      accent: brand.primary,
      primary: brand.primary,
      glow: alpha(brand.primary, 0.18),
    };
  return {
    background: brand.background,
    surface: alpha(brand.foreground, 0.06),
    foreground: brand.foreground,
    muted: alpha(brand.foreground, 0.72),
    accent: brand.accent,
    primary: brand.primary,
    glow: alpha(brand.primary, 0.55),
  };
}

const dataUrl = (file: { bytes: Buffer; mime: string }) =>
  `data:${file.mime};base64,${file.bytes.toString("base64")}`;

function div(style: CSSProperties, ...children: ReactNode[]) {
  return h("div", { style: { display: "flex", ...style } }, ...children);
}

function text(style: CSSProperties, value: string) {
  return h("div", { style: { display: "flex", ...style } }, value);
}

function brandRow(
  context: VisualContext,
  colors: Palette,
  scale: number,
): ReactNode {
  return div(
    { alignItems: "center", gap: 18 * scale },
    context.logo
      ? h("img", {
          src: dataUrl(context.logo),
          width: 52 * scale,
          height: 52 * scale,
          style: { borderRadius: 12 * scale, objectFit: "contain" },
        })
      : div(
          {
            width: 52 * scale,
            height: 52 * scale,
            borderRadius: 14 * scale,
            backgroundImage: `linear-gradient(135deg, ${colors.primary}, ${colors.accent})`,
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            fontSize: 26 * scale,
            fontWeight: 700,
          },
          context.product.name.slice(0, 1).toUpperCase(),
        ),
    text(
      {
        fontSize: 28 * scale,
        fontWeight: 600,
        color: colors.foreground,
        letterSpacing: -0.4,
      },
      context.product.name,
    ),
  );
}

function footer(
  context: VisualContext,
  colors: Palette,
  scale: number,
): ReactNode {
  const site = context.product.website
    ?.replace(/^https:\/\//, "")
    .replace(/\/$/, "");
  return div(
    { justifyContent: "space-between", alignItems: "center", width: "100%" },
    text(
      { fontSize: 22 * scale, color: colors.muted },
      site ?? context.product.tagline,
    ),
    context.version
      ? text(
          {
            fontSize: 20 * scale,
            fontWeight: 600,
            color: colors.foreground,
            padding: `${8 * scale}px ${16 * scale}px`,
            borderRadius: 999,
            border: `${2 * scale}px solid ${alpha(colors.accent, 0.6)}`,
          },
          `v${context.version.replace(/^v/i, "")}`,
        )
      : div({}),
  );
}

function eyebrow(value: string, colors: Palette, scale: number): ReactNode {
  return text(
    {
      alignSelf: "flex-start",
      fontSize: 22 * scale,
      fontWeight: 600,
      color: colors.accent,
      textTransform: "uppercase",
      letterSpacing: 3 * scale,
    },
    value,
  );
}

function frame(
  image: { bytes: Buffer; mime: string },
  colors: Palette,
  scale: number,
  size: { width: number; height: number },
): ReactNode {
  const bar = 40 * scale;
  return div(
    {
      flexDirection: "column",
      width: size.width,
      height: size.height,
      borderRadius: 18 * scale,
      overflow: "hidden",
      backgroundColor: colors.surface,
      border: `${2 * scale}px solid ${alpha(colors.foreground, 0.12)}`,
      boxShadow: `0 ${30 * scale}px ${80 * scale}px rgba(0,0,0,0.45)`,
    },
    div(
      {
        height: bar,
        alignItems: "center",
        gap: 10 * scale,
        paddingLeft: 18 * scale,
        backgroundColor: alpha(colors.foreground, 0.06),
      },
      ...["#ff5f57", "#febc2e", "#28c840"].map((color) =>
        div({
          width: 13 * scale,
          height: 13 * scale,
          borderRadius: 999,
          backgroundColor: color,
        }),
      ),
    ),
    h("img", {
      src: dataUrl(image),
      width: size.width,
      height: size.height - bar,
      style: { objectFit: "cover", objectPosition: "top" },
    }),
  );
}

function content(
  input: VisualInput,
  context: VisualContext,
  colors: Palette,
  size: { width: number; height: number },
): ReactNode {
  const scale = Math.min(size.width, size.height) / 1080;
  const tall = size.height > size.width * 0.9;
  const padding = 80 * scale;
  const headlineSize =
    (input.template === "quote" ? 64 : tall ? 88 : 76) * scale;
  const headline = text(
    {
      fontSize: headlineSize,
      fontWeight: 700,
      lineHeight: 1.08,
      letterSpacing: -1.5 * scale,
      color: colors.foreground,
    },
    input.template === "quote" ? `“${input.headline}”` : input.headline,
  );
  const subline = input.subline
    ? text(
        { fontSize: 32 * scale, lineHeight: 1.4, color: colors.muted },
        input.subline,
      )
    : null;
  const label =
    input.eyebrow ||
    (context.version && !input.headline.includes(context.version)
      ? `New in ${context.version}`
      : "");
  const spotlight = input.template === "spotlight" && context.image;
  const sideBySide = spotlight && !tall;
  const copy = div(
    {
      flexDirection: "column",
      gap: 26 * scale,
      justifyContent: "center",
      ...(sideBySide ? { width: Math.round(size.width * 0.36) } : { flex: 1 }),
    },
    label && input.template !== "quote" ? eyebrow(label, colors, scale) : null,
    headline,
    subline,
    input.template === "highlights" && input.items.length
      ? div(
          { flexDirection: "column", gap: 18 * scale, marginTop: 12 * scale },
          ...input.items.map((item, index) =>
            div(
              { alignItems: "center", gap: 20 * scale },
              text(
                {
                  width: 44 * scale,
                  height: 44 * scale,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: alpha(colors.accent, 0.18),
                  color: colors.accent,
                  fontSize: 22 * scale,
                  fontWeight: 700,
                },
                String(index + 1),
              ),
              text(
                {
                  fontSize: 32 * scale,
                  color: colors.foreground,
                  fontWeight: 600,
                },
                item,
              ),
            ),
          ),
        )
      : null,
  );
  const body = spotlight
    ? tall
      ? div(
          { flexDirection: "column", gap: 48 * scale, flex: 1 },
          copy,
          frame(context.image!, colors, scale, {
            width: size.width - padding * 2,
            height: Math.round(size.height * 0.46),
          }),
        )
      : div(
          { gap: 56 * scale, flex: 1, alignItems: "center" },
          copy,
          frame(context.image!, colors, scale, {
            width: Math.round(size.width * 0.52),
            height: Math.round(size.height * 0.62),
          }),
        )
    : copy;
  return div(
    {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding,
      gap: 40 * scale,
      fontFamily: "Geist",
      backgroundColor: colors.background,
      backgroundImage: `radial-gradient(circle at 88% 8%, ${colors.glow}, transparent 52%), radial-gradient(circle at 4% 100%, ${alpha(colors.accent, 0.22)}, transparent 46%)`,
    },
    brandRow(context, colors, scale),
    body,
    footer(context, colors, scale),
  );
}

export async function renderVisual(
  input: VisualInput,
  context: VisualContext,
  size: { width: number; height: number } = visualFormats[input.format],
): Promise<Buffer> {
  const colors = palette(input.theme, context.product.brand);
  const response = new ImageResponse(
    content(input, context, colors, size) as never,
    {
      width: size.width,
      height: size.height,
      fonts: await loadFonts(),
    },
  );
  return Buffer.from(await response.arrayBuffer());
}

export async function renderCaption(
  caption: string,
  brand: ProductBrand,
  size: { width: number; height: number },
): Promise<Buffer> {
  const scale = Math.min(size.width, size.height) / 1080;
  const response = new ImageResponse(
    div(
      {
        width: "100%",
        height: "100%",
        alignItems: "flex-end",
        justifyContent: "center",
        padding: 64 * scale,
        fontFamily: "Geist",
      },
      text(
        {
          maxWidth: size.width * 0.84,
          padding: `${20 * scale}px ${32 * scale}px`,
          borderRadius: 18 * scale,
          backgroundColor: alpha(brand.background, 0.86),
          borderLeft: `${8 * scale}px solid ${brand.accent}`,
          color: brand.foreground,
          fontSize: 40 * scale,
          fontWeight: 600,
          lineHeight: 1.3,
        },
        caption,
      ),
    ) as never,
    { width: size.width, height: size.height, fonts: await loadFonts() },
  );
  return Buffer.from(await response.arrayBuffer());
}
