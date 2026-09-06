import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMachdochCliLaunch } from "./machdoch-cli-launch.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createRuntimeFiles = async (): Promise<{
  root: string;
  runtime: string;
  entry: string;
  loader: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-cli-launch-"));
  roots.push(root);
  const runtime = join(root, "machdoch node.exe");
  const entry = join(root, "machdoch cli.cjs");
  const loaderDirectory = join(root, "node_modules", "fixture-loader");
  const loader = join(loaderDirectory, "index.js");
  await mkdir(loaderDirectory, { recursive: true });
  await Promise.all([
    writeFile(runtime, "runtime", "utf8"),
    writeFile(entry, "entry", "utf8"),
    writeFile(loader, "export {};\n", "utf8"),
    writeFile(
      join(loaderDirectory, "package.json"),
      '{"main":"index.js"}\n',
      "utf8",
    ),
  ]);
  return { root, runtime, entry, loader };
};

describe("Machdoch CLI launch descriptor", () => {
  it("preserves the packaged runtime, entry path, working directory, and config root", async () => {
    const { root, runtime, entry } = await createRuntimeFiles();

    expect(
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: [],
        argv: [runtime, entry],
        cwd: root,
        environment: {
          MACHDOCH_USER_CONFIG_DIR: join(root, "Machdoch Config"),
        },
      }),
    ).toEqual({
      command: runtime,
      args: [entry],
      cwd: root,
      environment: {
        MACHDOCH_USER_CONFIG_DIR: join(root, "Machdoch Config"),
      },
    });
  });

  it("resolves source-loader arguments without shell quoting", async () => {
    const { root, runtime, entry, loader } = await createRuntimeFiles();

    expect(
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: ["--import", "fixture-loader"],
        argv: [runtime, entry],
        cwd: root,
        environment: {},
      }).args,
    ).toEqual(["--import", pathToFileURL(loader).href, entry]);
  });

  it("fails explicitly when the running CLI entry cannot be relaunched", async () => {
    const { root, runtime } = await createRuntimeFiles();

    expect(() =>
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: [],
        argv: [runtime],
        cwd: root,
        environment: {},
      }),
    ).toThrow("has no entry script");
  });

  it.each(["--import", "--loader", "--experimental-loader"])(
    "resolves import-only package exports for %s in both argument forms",
    async (flag) => {
      const { root, runtime, entry, loader } = await createRuntimeFiles();
      await writeFile(
        join(root, "node_modules", "fixture-loader", "package.json"),
        JSON.stringify({ exports: { "./register": { import: "./index.js" } } }),
      );

      expect(
        resolveMachdochCliLaunch({
          execPath: runtime,
          execArgv: [
            flag,
            "fixture-loader/register",
            `${flag}=fixture-loader/register`,
          ],
          argv: [runtime, entry],
          cwd: root,
          environment: {},
        }).args,
      ).toEqual([
        flag,
        pathToFileURL(loader).href,
        `${flag}=${pathToFileURL(loader).href}`,
        entry,
      ]);
    },
  );

  it("keeps import and require export conditions distinct", async () => {
    const { root, runtime, entry, loader } = await createRuntimeFiles();
    const required = join(
      root,
      "node_modules",
      "fixture-loader",
      "required.cjs",
    );
    await writeFile(required, "module.exports = {};\n");
    await writeFile(
      join(root, "node_modules", "fixture-loader", "package.json"),
      JSON.stringify({
        exports: { import: "./index.js", require: "./required.cjs" },
      }),
    );

    expect(
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: [
          "--import",
          "fixture-loader",
          "-r",
          "fixture-loader",
          "--require=fixture-loader",
        ],
        argv: [runtime, entry],
        cwd: root,
        environment: {},
      }).args,
    ).toEqual([
      "--import",
      pathToFileURL(loader).href,
      "-r",
      required,
      `--require=${required}`,
      entry,
    ]);
  });

  it("pins relative and absolute imports as file URLs", async () => {
    const { root, runtime, entry, loader } = await createRuntimeFiles();
    expect(
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: [
          "--import",
          "./node_modules/fixture-loader/index.js",
          "--import",
          loader,
        ],
        argv: [runtime, entry],
        cwd: root,
        environment: {},
      }).args,
    ).toEqual([
      "--import",
      pathToFileURL(loader).href,
      "--import",
      pathToFileURL(loader).href,
      entry,
    ]);
  });

  it("reports unresolved preloads and missing option values", async () => {
    const { root, runtime, entry } = await createRuntimeFiles();
    const descriptor = {
      execPath: runtime,
      argv: [runtime, entry],
      cwd: root,
      environment: {},
    };
    expect(() =>
      resolveMachdochCliLaunch({
        ...descriptor,
        execArgv: ["--import", "missing-loader"],
      }),
    ).toThrow("cannot be resolved");
    expect(() =>
      resolveMachdochCliLaunch({ ...descriptor, execArgv: ["--import"] }),
    ).toThrow("has no value");
  });

  it("pins a relative user config override to the launch directory", async () => {
    const { root, runtime, entry } = await createRuntimeFiles();

    expect(
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: [],
        argv: [runtime, entry],
        cwd: root,
        environment: { MACHDOCH_USER_CONFIG_DIR: "user-config" },
      }).environment,
    ).toEqual({
      MACHDOCH_USER_CONFIG_DIR: join(root, "user-config"),
    });
  });

  it("rejects launch values that cannot be represented safely", async () => {
    const { root, runtime, entry } = await createRuntimeFiles();

    expect(() =>
      resolveMachdochCliLaunch({
        execPath: runtime,
        execArgv: [],
        argv: [runtime, entry],
        cwd: root,
        environment: {
          MACHDOCH_USER_CONFIG_DIR: `${root}\tinvalid`,
        },
      }),
    ).toThrow("launch environment value");
  });
});
