import { describe, expect, it } from "vitest";
import {
  brandFaviconSvg,
  brandPalette,
  brandStylesheet,
  contrastRatio,
  readableOn,
} from "./brand-palette";

describe("brand palette", () => {
  it("keeps colors that are already readable on the surface", () => {
    expect(readableOn("#7bc8ef", "#141519")).toBe("#7bc8ef");
    expect(readableOn("#0b5394", "#ffffff")).toBe("#0b5394");
  });

  it("lightens dark brand colors for dark surfaces and darkens light ones for light surfaces", () => {
    const dark = readableOn("#0b2a6f", "#141519");
    const light = readableOn("#ffe066", "#ffffff");
    expect(contrastRatio(dark, "#141519")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(dark).not.toBe("#0b2a6f");
    expect(light).not.toBe("#ffe066");
  });

  it("derives readable foregrounds and adjusts gradients per theme", () => {
    const palette = brandPalette({ color: "#e30613", gradient: "#fde047" });
    for (const theme of [palette.dark, palette.light])
      expect(
        contrastRatio(theme.primary, theme.foreground),
      ).toBeGreaterThanOrEqual(3);
    expect(palette.light.gradient).not.toBe("#fde047");
    expect(
      contrastRatio(palette.light.gradient!, "#ffffff"),
    ).toBeGreaterThanOrEqual(4.5);
    expect(brandPalette({ color: "#7bc8ef", gradient: null }).dark).toEqual({
      primary: "#7bc8ef",
      foreground: expect.stringMatching(/^#[0-9a-f]{6}$/u),
      gradient: null,
    });
  });

  it("builds scoped theme stylesheets with shape and fill variables", () => {
    const css = brandStylesheet(
      { color: "#73d7b1", gradient: "#5fd0d6", shape: "circle" },
      ".cloud-shell",
    );
    expect(css).toContain("body:has(.cloud-shell){--primary:#73d7b1;");
    expect(css).toContain("--cloud-brand-radius:50%;");
    expect(css).toContain("linear-gradient(135deg, #73d7b1, #5fd0d6)");
    expect(css).toMatch(
      /^html\[data-theme="light"\] body:has\(\.cloud-shell\)\{--primary:#[0-9a-f]{6};/mu,
    );
  });

  it("renders favicons with escaped text glyphs and embedded icons", () => {
    const colors = brandPalette({ color: "#a79bff", gradient: null }).dark;
    expect(
      brandFaviconSvg({
        colors,
        shape: "square",
        glyph: { kind: "text", text: "A&" },
      }),
    ).toContain(">A&#38;</text>");
    const icon = brandFaviconSvg({
      colors,
      shape: "rounded",
      glyph: { kind: "icon", markup: '<path d="M1 1h2"/>' },
    });
    expect(icon).toContain('<path d="M1 1h2"/>');
    expect(icon).toContain(`fill="${colors.primary}"`);
  });
});
