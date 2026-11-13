import "./cloud.css";
import type { Metadata } from "next";
import { cache } from "react";
import { SignInBrandProvider } from "@/components/cloud/sign-in-brand";
import { readSignInBrand } from "@/server/cloud/branding";
import { getCloudRuntime } from "@/server/cloud/runtime";

export const dynamic = "force-dynamic";

const signInBrand = cache(async () =>
  readSignInBrand((await getCloudRuntime()).database),
);

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await signInBrand())?.name ?? "machdoch.cloud" };
}

export default async function CloudLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SignInBrandProvider brand={await signInBrand()}>
      {children}
    </SignInBrandProvider>
  );
}
