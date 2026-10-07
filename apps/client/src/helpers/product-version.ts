import { createRequire } from "node:module";

export function getProductVersion(): string {
  const bundled = (globalThis as { __MACHDOCH_PRODUCT_VERSION__?: string })
    .__MACHDOCH_PRODUCT_VERSION__;
  return (
    bundled ??
    (
      createRequire(import.meta.url)("../../package.json") as {
        version: string;
      }
    ).version
  );
}
