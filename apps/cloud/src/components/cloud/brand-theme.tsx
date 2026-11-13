"use client";

import { useEffect, useRef } from "react";
import {
  brandFaviconSvg,
  brandIdentityColors,
  brandStylesheet,
} from "@/lib/brand-palette";
import { organizationInitials } from "@/lib/organization-brand";
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
  const { brand, logo, name } = identity;
  const Icon = brandIconComponents[brand.icon];
  useEffect(() => {
    const href =
      brand.mark === "image" && logo
        ? logo
        : `data:image/svg+xml,${encodeURIComponent(
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
                      markup:
                        glyph.current?.querySelector("svg")?.innerHTML ?? "",
                    },
            }),
          )}`;
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = href;
    const keepLast = () => {
      const icons = document.head.querySelectorAll('link[rel~="icon"]');
      if (icons[icons.length - 1] !== link) document.head.append(link);
    };
    keepLast();
    const observer = new MutationObserver(keepLast);
    observer.observe(document.head, { childList: true });
    return () => {
      observer.disconnect();
      link.remove();
    };
  }, [brand, logo, name]);
  return (
    <span ref={glyph} hidden>
      <Icon />
    </span>
  );
}
