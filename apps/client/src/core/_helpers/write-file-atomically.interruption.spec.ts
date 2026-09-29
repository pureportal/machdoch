import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("atomic file persistence after process termination", () => {
  it("leaves only the installed launcher in Startup when killed before commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atomic-interruption-"));
    const startupDirectory = join(directory, "Startup");
    const temporaryDirectory = join(directory, "staging");
    const path = join(startupDirectory, "launcher.vbs");
    await mkdir(startupDirectory);
    await writeFile(path, "installed", "utf8");
    const helperUrl = new URL(
      "./write-file-atomically.helper.ts",
      import.meta.url,
    );
    const script = `
      import { writeFileAtomically } from ${JSON.stringify(helperUrl.href)};
      await writeFileAtomically(${JSON.stringify(path)}, "replacement", "utf8", {
        temporaryDirectory: ${JSON.stringify(temporaryDirectory)},
        beforeCommit: async () => {
          process.send({ ready: true });
          await new Promise(resolve => setTimeout(resolve, 30_000));
        },
      });
    `;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
    );
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await once(child, "message", {
        signal: AbortSignal.timeout(10_000),
      }).catch((error: unknown) => {
        throw new Error(
          `The staged-write process did not become ready: ${stderr}`,
          {
            cause: error,
          },
        );
      });
      expect(child.kill("SIGKILL")).toBe(true);
      await closed;

      expect(await readFile(path, "utf8")).toBe("installed");
      expect(await readdir(startupDirectory)).toEqual(["launcher.vbs"]);
      const abandonedFiles = await readdir(temporaryDirectory);
      expect(abandonedFiles).toHaveLength(1);
      expect(
        await readFile(join(temporaryDirectory, abandonedFiles[0]!), "utf8"),
      ).toBe("replacement");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
