import { describe, expect, it } from "vitest";
import { organizationUpdateSchema } from "./cloud-administration-contract";
import {
  brandLogoSchema,
  defaultOrganizationBrand,
  isBrandLogo,
  organizationBrandSchema,
  organizationInitials,
} from "./organization-brand";

const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const png = `data:image/png;base64,${base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])}`;
const webp = `data:image/webp;base64,${base64([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WEBP", (c) => c.charCodeAt(0))])}`;

describe("organization brand", () => {
  it("derives initials from words, camel case and custom overrides", () => {
    expect(organizationInitials("PurePortal")).toBe("PP");
    expect(organizationInitials("northstar studio labs")).toBe("NS");
    expect(organizationInitials("acme")).toBe("A");
    expect(organizationInitials("data-driven")).toBe("DD");
    expect(organizationInitials("Acme", "x")).toBe("X");
  });

  it("accepts raster logos only when the content matches the declared type", () => {
    expect(isBrandLogo(png)).toBe(true);
    expect(isBrandLogo(webp)).toBe(true);
    expect(isBrandLogo(png.replace("image/png", "image/jpeg"))).toBe(false);
    expect(
      isBrandLogo(`data:image/svg+xml;base64,${btoa("<svg></svg>")}`),
    ).toBe(false);
    expect(
      brandLogoSchema.safeParse(`${png}${"A".repeat(60_000)}`).success,
    ).toBe(false);
  });

  it("normalizes colors and initials and rejects unsupported values", () => {
    expect(
      organizationBrandSchema.parse({
        ...defaultOrganizationBrand,
        color: "#ABCDEF",
        gradient: "#FFFFFF",
        initials: " pp ",
      }),
    ).toMatchObject({ color: "#abcdef", gradient: "#ffffff", initials: "PP" });
    expect(
      organizationBrandSchema.safeParse({
        ...defaultOrganizationBrand,
        initials: "<b>",
      }).success,
    ).toBe(false);
    expect(
      organizationBrandSchema.safeParse({
        ...defaultOrganizationBrand,
        icon: "unknown",
      }).success,
    ).toBe(false);
  });

  it("requires an uploaded logo when the image mark is selected", () => {
    const input = {
      revision: 1,
      name: "Acme",
      brand: { ...defaultOrganizationBrand, mark: "image" },
    };
    expect(
      organizationUpdateSchema.safeParse({ ...input, logo: null }).success,
    ).toBe(false);
    expect(
      organizationUpdateSchema.safeParse({ ...input, logo: png }).success,
    ).toBe(true);
  });
});
