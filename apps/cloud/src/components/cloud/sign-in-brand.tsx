"use client";

import { createContext, useContext } from "react";
import type { BrandIdentity } from "./brand-mark";

const SignInBrandContext = createContext<BrandIdentity | null>(null);

export function SignInBrandProvider({
  brand,
  children,
}: {
  brand: BrandIdentity | null;
  children: React.ReactNode;
}) {
  return (
    <SignInBrandContext.Provider value={brand}>
      {children}
    </SignInBrandContext.Provider>
  );
}

export function useSignInBrand(): BrandIdentity | null {
  return useContext(SignInBrandContext);
}
