import { join } from "node:path";
import {
  watchRootCanTraversePath,
  watchRootMatchesPath,
} from "./watch-root-matches-path.helper.ts";
import type { RalphWatchRoot } from "../ralph-watches.ts";

const createRoot = (overrides: Partial<RalphWatchRoot> = {}): RalphWatchRoot => ({
  path: join(process.cwd(), "workspace"),
  include: [],
  exclude: [],
  ...overrides,
});

describe("watchRootMatchesPath", () => {
  it("matches paths inside the root when no include or exclude globs are set", () => {
    const root = createRoot();

    expect(watchRootMatchesPath(root, join(root.path, "src", "index.ts"))).toBe(true);
  });

  it("rejects paths outside the root", () => {
    const root = createRoot();

    expect(watchRootMatchesPath(root, join(process.cwd(), "outside.ts"))).toBe(false);
  });

  it("requires include globs when provided", () => {
    const root = createRoot({ include: ["src/**/*.ts"] });

    expect(watchRootMatchesPath(root, join(root.path, "src", "core", "app.ts"))).toBe(true);
    expect(watchRootMatchesPath(root, join(root.path, "README.md"))).toBe(false);
  });

  it("lets exclude globs override include matches", () => {
    const root = createRoot({
      include: ["src/**"],
      exclude: ["src/**/*.spec.ts", "src/generated/**"],
    });

    expect(watchRootMatchesPath(root, join(root.path, "src", "app.ts"))).toBe(true);
    expect(watchRootMatchesPath(root, join(root.path, "src", "app.spec.ts"))).toBe(false);
    expect(watchRootMatchesPath(root, join(root.path, "src", "generated", "api.ts"))).toBe(false);
  });
});

describe("watchRootCanTraversePath", () => {
  it("allows the root itself and non-excluded descendants", () => {
    const root = createRoot({ exclude: ["dist/**"] });

    expect(watchRootCanTraversePath(root, root.path)).toBe(true);
    expect(watchRootCanTraversePath(root, join(root.path, "src"))).toBe(true);
  });

  it("rejects excluded directories before scanning descendants", () => {
    const root = createRoot({ exclude: ["dist/**", "node_modules/**"] });

    expect(watchRootCanTraversePath(root, join(root.path, "dist"))).toBe(false);
    expect(watchRootCanTraversePath(root, join(root.path, "node_modules"))).toBe(false);
  });
});
