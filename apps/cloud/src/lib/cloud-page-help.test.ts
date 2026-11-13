import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pageHelp } from "./cloud-page-help";
import { sidebarItems, sidebarPages } from "./cloud-sidebar-contract";
import { builtinRoles } from "./cloud-permissions";

const pageHrefs = new Set(
  sidebarItems.flatMap((item) =>
    sidebarPages(item, {
      owner: true,
      permissions: builtinRoles.owner.permissions,
    }).map((page) => page.href),
  ),
);
const publicDirectory = new URL("../../public/", import.meta.url);

describe("page help", () => {
  it("links only to sidebar pages and bundled images", () => {
    expect(pageHelp.size).toBeGreaterThan(0);
    for (const [href, content] of pageHelp) {
      expect(content.length, href).toBeGreaterThan(0);
      for (const [, target] of content.matchAll(
        /(?<!!)\[[^\]]+\]\((\/[^)]*)\)/g,
      ))
        expect(pageHrefs, `${href} → ${target}`).toContain(target);
      for (const [, source] of content.matchAll(/!\[[^\]]*\]\(\/([^)]+)\)/g))
        expect(
          existsSync(fileURLToPath(new URL(source!, publicDirectory))),
          `${href} → ${source}`,
        ).toBe(true);
    }
  });
});
