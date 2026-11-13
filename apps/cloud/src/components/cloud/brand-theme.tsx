"use client";

import { useEffect, useRef } from "react";
import {
  brandFaviconSvg,
  brandIdentityColors,
  brandStylesheet,
} from "@/lib/brand-palette";
import { brandLogo, organizationInitials } from "@/lib/organization-brand";
import { brandIconComponents, type BrandIdentity } from "./brand-mark";

export function BrandStyle({
  identity,
  scope,
}: {
  identity: BrandIdentity;
  scope: string;
}) {
  return <style>{brandStylesheet(identity.brand, scope)}</style>;
}

export function BrandFavicon({ identity }: { identity: BrandIdentity }) {
  const glyph = useRef<HTMLSpanElement>(null);
  const { brand, logoDark, logoLight, name } = identity;
  const Icon = brandIconComponents[brand.icon];
  useEffect(() => {
    const generatedHref = () =>
      `data:image/svg+xml,${encodeURIComponent(
        brandFaviconSvg({
          colors: brandIdentityColors(brand),
          shape: brand.shape,
          glyph:
            brand.mark === "initials"
              ? {
                  kind: "text",
                  text: organizationInitials(name, brand.initials),
                }
              : {
                  kind: "icon",
                  markup: glyph.current?.querySelector("svg")?.innerHTML ?? "",
                },
        }),
      )}`;
    const link = document.createElement("link");
    link.rel = "icon";
    const lightScheme = window.matchMedia("(prefers-color-scheme: light)");
    const showScheme = () => {
      const logo =
        brand.mark === "image"
          ? brandLogo(
              { logoDark, logoLight },
              lightScheme.matches ? "light" : "dark",
            )
          : null;
      link.href = logo ?? generatedHref();
    };
    showScheme();
    lightScheme.addEventListener("change", showScheme);
    const keepLast = () => {
      const icons = document.head.querySelectorAll('link[rel~="icon"]');
      if (icons[icons.length - 1] !== link) document.head.append(link);
    };
    keepLast();
    const observer = new MutationObserver(keepLast);
    observer.observe(document.head, { childList: true });
    return () => {
      lightScheme.removeEventListener("change", showScheme);
      observer.disconnect();
      link.remove();
    };
  }, [brand, logoDark, logoLight, name]);
  return (
    <span ref={glyph} hidden>
      <Icon />
    </span>
  );
}
