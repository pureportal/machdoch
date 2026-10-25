import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  openWindowsSocket,
  prepareWindowsSocketDirectory,
} from "../../../packages/cloud-client/src/worker/sandbox/windows-socket.ts";

const executable = process.env.MACHDOCH_CLOUD_SUPERVISOR;
assert.ok(
  executable,
  "Set MACHDOCH_CLOUD_SUPERVISOR to the built native helper.",
);
const root = fileURLToPath(
  new URL("../../../.tmp/cloud-socket-tests/", import.meta.url),
);
await mkdir(root, { recursive: true });

await test(
  "creates a protected socket directory and refuses replacement or redirected parents",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(root, "case-"));
    const target = join(directory, "private 工作");
    await prepareWindowsSocketDirectory(executable, target);
    const { stdout } = await promisify(execFile)(
      join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$acl=Get-Acl -LiteralPath $env:MACHDOCH_SOCKET_TEST_DIRECTORY; @{protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Depth 4 -Compress",
      ],
      {
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          MACHDOCH_SOCKET_TEST_DIRECTORY: target,
        },
        timeout: 10000,
        maxBuffer: 8192,
      },
    );
    const acl = JSON.parse(stdout);
    assert.equal(acl.protected, true);
    assert.deepEqual(acl.rules.map((rule) => rule.sid).sort(), [
      "S-1-3-4",
      "S-1-5-18",
    ]);
    assert.ok(
      acl.rules.every((rule) => !rule.inherited && rule.type === "Allow"),
    );
    await writeFile(join(target, "retained.txt"), "preserve");
    await assert.rejects(prepareWindowsSocketDirectory(executable, target));
    assert.equal(
      await readFile(join(target, "retained.txt"), "utf8"),
      "preserve",
    );
    const redirected = join(directory, "redirected");
    await symlink(target, redirected, "junction");
    await assert.rejects(
      prepareWindowsSocketDirectory(executable, join(redirected, "nested")),
      /redirected parents/,
    );
    await assert.rejects(access(join(target, "nested")), { code: "ENOENT" });
  },
);

await test(
  "closing an unconnected socket bridge terminates its native process",
  { skip: process.platform !== "win32", timeout: 5000 },
  async () => {
    const directory = await mkdtemp(join(root, "bridge-"));
    const bridge = openWindowsSocket(executable, directory);
    bridge.stream.on("error", () => {});
    await bridge.close();
    assert.equal(bridge.stream.destroyed, true);
  },
);
