import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UiControlRuntimeInfo } from "../types.js";

const execFileAsync = promisify(execFile);
const UI_CONTROL_BRIDGE_MAX_BUFFER_BYTES = 50_000_000;

export interface DesktopUiMonitorInfo {
  id: number;
  name: string;
  friendlyName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface DesktopUiWindowInfo {
  id: number;
  pid: number;
  appName: string;
  title: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  isMinimized: boolean;
  isMaximized: boolean;
  isFocused: boolean;
  monitorId?: number;
  monitorName?: string;
  nativeHandle?: string;
}

export interface DesktopUiWindowControlInfo {
  handle: string;
  parentHandle: string;
  className: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isVisible: boolean;
  isEnabled: boolean;
}

export interface DesktopUiImagePayload {
  mediaType: "image/png";
  data: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface DesktopUiMonitorCapture {
  image: DesktopUiImagePayload;
  monitor: DesktopUiMonitorInfo;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DesktopUiWindowCapture {
  image: DesktopUiImagePayload;
  window: DesktopUiWindowInfo;
}

interface DesktopUiBridgeRequest {
  action: string;
  payload?: Record<string, unknown>;
}

interface DesktopUiBridgeSuccess<T> {
  ok: true;
  data: T;
}

interface DesktopUiBridgeFailure {
  ok: false;
  error: string;
}

type DesktopUiBridgeResponse<T> =
  | DesktopUiBridgeSuccess<T>
  | DesktopUiBridgeFailure;

const createRequestFilePath = (): string => {
  return join(tmpdir(), `machdoch-ui-control-${crypto.randomUUID()}.json`);
};

const getBridgeCommand = (uiControl: UiControlRuntimeInfo): string => {
  const bridgeCommand = uiControl.bridgeCommand?.trim();

  if (!bridgeCommand) {
    throw new Error(
      "Desktop UI control is enabled, but the native bridge command is unavailable.",
    );
  }

  return bridgeCommand;
};

export const assertUiControlAvailable = (
  uiControl: UiControlRuntimeInfo | undefined,
): UiControlRuntimeInfo => {
  if (!uiControl) {
    throw new Error(
      "Desktop UI control is unavailable because this run is not connected to a desktop bridge.",
    );
  }

  if (!uiControl.available) {
    throw new Error(
      uiControl.reason ??
        "Desktop UI control is unavailable in the current environment.",
    );
  }

  return uiControl;
};

export const executeDesktopUiBridge = async <T>(
  uiControl: UiControlRuntimeInfo | undefined,
  action: string,
  payload?: Record<string, unknown>,
): Promise<T> => {
  const availableUiControl = assertUiControlAvailable(uiControl);
  const requestFilePath = createRequestFilePath();
  const request: DesktopUiBridgeRequest = {
    action,
    ...(payload ? { payload } : {}),
  };

  await writeFile(requestFilePath, JSON.stringify(request), "utf8");

  try {
    const { stdout, stderr } = await execFileAsync(
      getBridgeCommand(availableUiControl),
      ["--ui-control-bridge-request-file", requestFilePath],
      {
        windowsHide: true,
        maxBuffer: UI_CONTROL_BRIDGE_MAX_BUFFER_BYTES,
      },
    );
    const normalizedStdout = stdout.trim();
    const normalizedStderr = stderr.trim();

    if (normalizedStdout.length === 0) {
      throw new Error(
        normalizedStderr.length > 0
          ? normalizedStderr
          : "The desktop UI bridge returned an empty response.",
      );
    }

    const response = JSON.parse(normalizedStdout) as DesktopUiBridgeResponse<T>;

    if (!response.ok) {
      throw new Error(response.error);
    }

    return response.data;
  } catch (error) {
    if (error instanceof Error) {
      const stdout = "stdout" in error ? error.stdout : undefined;
      const stderr = "stderr" in error ? error.stderr : undefined;
      const normalizedStdout = typeof stdout === "string" ? stdout.trim() : "";
      const normalizedStderr = typeof stderr === "string" ? stderr.trim() : "";

      if (normalizedStdout.length > 0) {
        try {
          const response = JSON.parse(
            normalizedStdout,
          ) as DesktopUiBridgeResponse<T>;

          if (!response.ok) {
            throw new Error(response.error, { cause: error });
          }

          return response.data;
        } catch {
          // Fall through to the best available error message below.
        }
      }

      if (normalizedStderr.length > 0) {
        throw new Error(normalizedStderr, { cause: error });
      }

      throw error;
    }

    throw new Error(String(error), { cause: error });
  } finally {
    await unlink(requestFilePath).catch(() => undefined);
  }
};
