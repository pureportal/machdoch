import { describe, expect, it } from "vitest";
import { pathMatcher, touchesPaths } from "./release-pipeline-paths";

describe("release pipeline paths", () => {
  it("matches directories, globs and recursive globs", () => {
    const matches = pathMatcher(["apps/web", "packages/*/src/**", "**/*.sql"]);
    expect(matches("apps/web/src/page.tsx")).toBe(true);
    expect(matches("./apps/web/")).toBe(true);
    expect(matches("apps/website/index.ts")).toBe(false);
    expect(matches("packages/ui/src/button/index.ts")).toBe(true);
    expect(matches("packages/ui/test/button.ts")).toBe(false);
    expect(matches("db/migrations/001.sql")).toBe(true);
    expect(matches("schema.sql")).toBe(true);
  });

  it("drops excluded paths and keeps everything without includes", () => {
    const matches = pathMatcher(["apps/api/**", "!apps/api/**/*.md"]);
    expect(matches("apps/api/src/server.ts")).toBe(true);
    expect(matches("apps/api/docs/readme.md")).toBe(false);
    const everythingButDocs = pathMatcher(["!docs"]);
    expect(everythingButDocs("src/index.ts")).toBe(true);
    expect(everythingButDocs("docs/guide.md")).toBe(false);
  });

  it("treats an empty pattern list as the whole repository", () => {
    expect(touchesPaths([], [])).toBe(true);
    expect(touchesPaths(["apps/web"], [])).toBe(false);
    expect(touchesPaths(["apps/web"], ["apps/api/a.ts", "apps/web/b.ts"])).toBe(
      true,
    );
  });
});
