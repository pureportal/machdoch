import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testUserConfigRoot = mkdtempSync(
  join(tmpdir(), "machdoch-vitest-user-config-"),
);

process.env.MACHDOCH_USER_CONFIG_DIR = testUserConfigRoot;

process.once("exit", () => {
  const absoluteRoot = resolve(testUserConfigRoot);
  const absoluteTemporaryRoot = resolve(tmpdir());
  const relativeToTemporaryRoot = absoluteRoot.slice(
    absoluteTemporaryRoot.length,
  );

  if (
    absoluteRoot.startsWith(`${absoluteTemporaryRoot}${process.platform === "win32" ? "\\" : "/"}`) &&
    relativeToTemporaryRoot.includes("machdoch-vitest-user-config-")
  ) {
    rmSync(absoluteRoot, { recursive: true, force: true });
  }
});
