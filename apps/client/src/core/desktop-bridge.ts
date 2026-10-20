import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "./env.js";

interface DesktopBridgeDescriptor {
  version: 1;
  pid: number;
  port: number;
  token: string;
}

export const readDesktopSettingsDescriptor = async (): Promise<
  DesktopBridgeDescriptor | undefined
> => {
  let raw: string;
  try {
    raw = await readFile(
      join(dirname(getUserConfigPath()), "cli-settings-bridge.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const descriptor: DesktopBridgeDescriptor = JSON.parse(raw);
  if (
    descriptor.version !== 1 ||
    !Number.isInteger(descriptor.pid) ||
    !Number.isInteger(descriptor.port) ||
    descriptor.port < 1 ||
    descriptor.port > 65535 ||
    !/^[0-9a-f]{64}$/u.test(descriptor.token)
  )
    throw new Error(
      "Desktop settings connection is invalid. Restart the desktop app.",
    );
  try {
    process.kill(descriptor.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
  return descriptor;
};

export const requestDesktopSettings = async (
  action: "snapshot" | "set" | "action" | "transfer" | "speech" | "speech-remote",
  setting = "",
  value?: unknown,
): Promise<unknown> => {
  const descriptor = await readDesktopSettingsDescriptor();
  if (!descriptor)
    throw new Error(action === "speech" ? "Start the owning device's native Machdoch runtime to use speech automation." : "Open the desktop app to edit this setting.");
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: descriptor.port,
    });
    let data = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(action === "snapshot" ? 2_000 : 120_000, () =>
      finish(
        new Error(
          "Desktop settings timed out. Restart the desktop app and try again.",
        ),
      ),
    );
    socket.once("error", () =>
      finish(
        new Error(
          "Desktop settings are unavailable. Restart the desktop app and try again.",
        ),
      ),
    );
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          token: descriptor.token,
          action,
          setting,
          ...(value === undefined ? {} : { value }),
        }) + "\n",
      ),
    );
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > (action.startsWith("speech") ? 16 * 1024 * 1024 : 1_000_000)) {
        finish(new Error("Desktop settings response is too large."));
        return;
      }
      if (!data.includes("\n")) return;
      try {
        const response = JSON.parse(data.slice(0, data.indexOf("\n"))) as {
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        finish(
          response.ok
            ? undefined
            : new Error(response.error ?? "Desktop settings failed."),
          response.data,
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () =>
      finish(new Error("Desktop settings connection ended before responding.")),
    );
  });
};
