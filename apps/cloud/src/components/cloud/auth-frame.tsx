"use client";

import Link from "next/link";
import { Command } from "lucide-react";
import { BrandMark } from "./brand-mark";
import { BrandStyle } from "./brand-theme";
import { useSignInBrand } from "./sign-in-brand";

export function AuthFrame({ children }: { children: React.ReactNode }) {
  const brand = useSignInBrand();
  return (
    <main className="cloud-auth" data-cloud-brand={brand ? "" : undefined}>
      {brand && (
        <BrandStyle identity={brand} scope=".cloud-auth[data-cloud-brand]" />
      )}
      <Link className="cloud-auth-brand" href="/cloud">
        {brand ? (
          <>
            <BrandMark identity={brand} />
            <span>{brand.name}</span>
          </>
        ) : (
          <>
            <span className="cloud-brand-mark">
              <Command size={20} />
            </span>
            <span>
              machdoch<span className="cloud-brand-suffix">.cloud</span>
            </span>
          </>
        )}
      </Link>
      <section className="cloud-auth-panel">{children}</section>
    </main>
  );
}
