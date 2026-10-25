import { execFile } from "node:child_process";
import { realpath, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  verifyRuntimeAsset,
  type RuntimeAsset,
} from "@machdoch/cloud-client/runtime-assets";

const identitySchema = z.strictObject({
  directory: z.string().min(1),
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  bytes: z
    .number()
    .int()
    .min(256 * 1024 * 1024)
    .max(16 * 1024 ** 3)
    .refine((value) => value % (1024 * 1024) === 0),
});
const volumeSchema = z.strictObject({
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  bytes: z.number().int().positive(),
  physicalBytes: z.number().int().positive(),
  phase: z.enum(["creating", "formatting", "ready", "active", "stopped"]),
  attached: z.boolean(),
  volumeId: z.string().nullable(),
});
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), volume: volumeSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

export type WindowsVolumeIdentity = z.infer<typeof identitySchema>;
export interface WindowsVolumeTools {
  helper: RuntimeAsset;
  controller: RuntimeAsset;
}
export type WindowsVolumeAction =
  | "create"
  | "inspect"
  | "begin"
  | "attach"
  | "detach";

export async function operateWindowsVolume(
  tools: WindowsVolumeTools,
  supplied: WindowsVolumeIdentity,
  action: WindowsVolumeAction,
): Promise<z.infer<typeof volumeSchema>> {
  if (process.platform !== "win32" || !process.env.SystemRoot)
    throw new Error("Bounded client volumes require Windows storage services.");
  const identity = identitySchema.parse(supplied);
  if (!isAbsolute(identity.directory))
    throw new Error("Volume storage must be absolute.");
  const helper = await verifyRuntimeAsset(tools.helper);
  const controller = await verifyRuntimeAsset(tools.controller);
  const systemRoot = await realpath(process.env.SystemRoot);
  const powershell = join(
    systemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const request = JSON.stringify({
    ...identity,
    action,
    helper,
    helperSha256: tools.helper.sha256,
  });
  if (Buffer.byteLength(request) > 16384)
    throw new Error("Volume request exceeds its limit.");
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", controller],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 65536,
        encoding: "utf8",
        env: {
          SystemRoot: systemRoot,
          windir: systemRoot,
          PSModulePath: join(
            systemRoot,
            "System32/WindowsPowerShell/v1.0/Modules",
          ),
          PATHEXT: ".EXE",
          TEMP: identity.directory,
          TMP: identity.directory,
        },
      },
      (error, stdout) => {
        if (error && !stdout.trim())
          reject(
            new Error(
              "Volume operation failed. Preserve its storage for recovery.",
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(request);
  });
  const result = responseSchema.parse(
    JSON.parse(output.replace(/^\uFEFF/, "")),
  );
  if (!result.ok) throw new Error(result.error);
  if (
    result.volume.id !== identity.id ||
    result.volume.attemptId !== identity.attemptId ||
    result.volume.bytes !== identity.bytes
  )
    throw new Error("The volume response belongs to another task.");
  if (
    result.volume.attached &&
    ["ready", "active", "stopped"].includes(result.volume.phase)
  ) {
    const filesystem = await statfs(join(identity.directory, "mount"));
    const capacity = filesystem.blocks * filesystem.bsize;
    if (capacity <= 0 || capacity > identity.bytes)
      throw new Error("The mounted volume exceeds its disk allowance.");
  }
  return result.volume;
}
