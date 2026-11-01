import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("content security policy", () => {
  it("allows blob images on instance pages for remote file previews", async () => {
    const rules = await nextConfig.headers!();
    const instanceRule = rules.find((rule) => rule.source === "/:path*")!;
    const policy = instanceRule.headers.find(
      (header) => header.key === "Content-Security-Policy",
    )!.value;

    expect(policy).toMatch(/img-src [^;]*\bblob:/u);
  });

  it("allows live voice only on instance pages", async () => {
    const rules = await nextConfig.headers!();
    const policyFor = (source: string): string =>
      rules
        .find((rule) => rule.source === source)!
        .headers.find((header) => header.key === "Content-Security-Policy")!
        .value;
    const instancePolicy = policyFor("/instances/:path*");
    const defaultPolicy = policyFor("/:path*");

    expect(instancePolicy).toMatch(/script-src [^;]*\bblob:/u);
    expect(instancePolicy).toMatch(/connect-src [^;]*wss:\/\/api\.openai\.com/u);
    expect(instancePolicy).toMatch(
      /connect-src [^;]*wss:\/\/generativelanguage\.googleapis\.com/u,
    );
    expect(instancePolicy).toMatch(/connect-src [^;]*swetrix\.pureportal\.io/u);
    expect(defaultPolicy).not.toMatch(/script-src [^;]*\bblob:/u);
    expect(defaultPolicy).not.toContain("wss:");
  });
});
