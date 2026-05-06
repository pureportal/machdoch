import type { UiControlRuntimeInfo } from "../types.js";
import {
  assertUiControlAvailable,
  type DesktopUiImagePayload,
  type DesktopUiMonitorCapture,
  type DesktopUiMonitorInfo,
  type DesktopUiWindowCapture,
  type DesktopUiWindowControlInfo,
  type DesktopUiWindowInfo,
  executeDesktopUiBridge,
} from "./desktop-ui-bridge.js";
import {
  coerceBoolean,
  coerceInteger,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
} from "./runtime-text.js";

const DEFAULT_CAPTURE_MAX_WIDTH = 1_440;
const DEFAULT_CAPTURE_MAX_HEIGHT = 900;
const DEFAULT_UI_WINDOW_RESULTS = 20;
const DEFAULT_UI_WAIT_TIMEOUT_MS = 8_000;
const DEFAULT_UI_WAIT_POLL_INTERVAL_MS = 500;
const MAX_UI_WINDOW_RESULTS = 40;
const MAX_UI_WAIT_TIMEOUT_MS = 30_000;
const MAX_UI_WAIT_POLL_INTERVAL_MS = 5_000;

const READ_ONLY_DESKTOP_UI_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_ui_monitors",
  "capture_ui_screen",
  "list_ui_windows",
  "capture_ui_window",
  "wait_for_ui_duration",
  "wait_for_ui_window",
  "list_windows_controls",
]);

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const createImageToolResultContent = (
  summary: string,
  image: DesktopUiImagePayload,
) => {
  return [
    {
      type: "text" as const,
      text: summary,
    },
    {
      type: "image" as const,
      mediaType: image.mediaType,
      data: image.data,
      detail: "original" as const,
    },
  ];
};

const formatMonitorLine = (monitor: DesktopUiMonitorInfo): string => {
  return [
    `${monitor.friendlyName} (#${monitor.id})`,
    `origin=(${monitor.x}, ${monitor.y})`,
    `size=${monitor.width}x${monitor.height}`,
    `scale=${monitor.scaleFactor}`,
    monitor.isPrimary ? "primary=yes" : "primary=no",
  ].join(" · ");
};

const formatWindowLine = (windowInfo: DesktopUiWindowInfo): string => {
  return [
    `${windowInfo.title || "(untitled window)"} (#${windowInfo.id})`,
    `app=${windowInfo.appName || "unknown"}`,
    `origin=(${windowInfo.x}, ${windowInfo.y})`,
    `size=${windowInfo.width}x${windowInfo.height}`,
    `focused=${windowInfo.isFocused ? "yes" : "no"}`,
    `minimized=${windowInfo.isMinimized ? "yes" : "no"}`,
    ...(windowInfo.nativeHandle ? [`handle=${windowInfo.nativeHandle}`] : []),
  ].join(" · ");
};

const formatControlLine = (control: DesktopUiWindowControlInfo): string => {
  return [
    `${control.className} (${control.handle})`,
    `text=${control.text || ""}`,
    `origin=(${control.x}, ${control.y})`,
    `size=${control.width}x${control.height}`,
    `visible=${control.isVisible ? "yes" : "no"}`,
    `enabled=${control.isEnabled ? "yes" : "no"}`,
  ].join(" · ");
};

const normalizeCaptureBounds = (
  args: Record<string, unknown>,
):
  | {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | undefined => {
  const x = coerceInteger(args, "x");
  const y = coerceInteger(args, "y");
  const width = coerceInteger(args, "width");
  const height = coerceInteger(args, "height");

  if (
    x === undefined &&
    y === undefined &&
    width === undefined &&
    height === undefined
  ) {
    return undefined;
  }

  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    throw new Error(
      "Expected `x`, `y`, `width`, and `height` together when capturing a UI region.",
    );
  }

  return { x, y, width, height };
};

const normalizeMaxCaptureSize = (args: Record<string, unknown>) => {
  const maxWidth = coerceInteger(args, "maxWidth") ?? DEFAULT_CAPTURE_MAX_WIDTH;
  const maxHeight =
    coerceInteger(args, "maxHeight") ?? DEFAULT_CAPTURE_MAX_HEIGHT;

  return {
    maxWidth,
    maxHeight,
  };
};

const normalizeUiKeyList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const keys = value
    .flatMap((entry) => (typeof entry === "string" ? [entry.trim()] : []))
    .filter((entry) => entry.length > 0);

  return keys.length > 0 ? keys : undefined;
};

const filterWindows = (
  windows: DesktopUiWindowInfo[],
  args: Record<string, unknown>,
): DesktopUiWindowInfo[] => {
  const includeMinimized = coerceBoolean(args, "includeMinimized") ?? false;
  const titleContains = coerceString(args, "titleContains")?.toLowerCase();
  const appNameContains = coerceString(args, "appNameContains")?.toLowerCase();
  const maxResults = Math.min(
    coerceInteger(args, "maxResults") ?? DEFAULT_UI_WINDOW_RESULTS,
    MAX_UI_WINDOW_RESULTS,
  );

  return windows
    .filter((windowInfo) => {
      if (!includeMinimized && windowInfo.isMinimized) {
        return false;
      }

      if (
        titleContains &&
        !windowInfo.title.toLowerCase().includes(titleContains)
      ) {
        return false;
      }

      if (
        appNameContains &&
        !windowInfo.appName.toLowerCase().includes(appNameContains)
      ) {
        return false;
      }

      return true;
    })
    .slice(0, maxResults);
};

const createCaptureSections = (
  title: string,
  summaryLines: string[],
  image: DesktopUiImagePayload,
) => {
  return [
    {
      title,
      lines: [
        ...summaryLines,
        `captured image: ${image.width}x${image.height}`,
        `original image: ${image.originalWidth}x${image.originalHeight}`,
      ],
    },
  ];
};

const buildDesktopUiToolDefinitions = (
  uiControl: UiControlRuntimeInfo | undefined,
): AgentToolDefinition[] => {
  const availableUiControl = assertUiControlAvailable(uiControl);

  const toolDefinitions: Array<Omit<AgentToolDefinition, "effect">> = [];

  if (availableUiControl.supportsWindowEnumeration) {
    toolDefinitions.push(
      {
        spec: {
          name: "list_ui_monitors",
          description:
            "List desktop monitors with their bounds and scale factors. Use this before capturing the full screen or a screen region.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
        backingTool: "shell",
        riskLevel: "low",
        execute: async (_args, context) => {
          try {
            const monitors = await executeDesktopUiBridge<
              DesktopUiMonitorInfo[]
            >(context.uiControl, "list_monitors");
            const monitorLines = monitors.map(formatMonitorLine);
            const output =
              monitorLines.length > 0
                ? [
                    `Detected ${monitors.length} monitor(s):`,
                    ...monitorLines,
                  ].join("\n")
                : "No monitors were detected by the desktop UI bridge.";

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "list_ui_monitors",
                output,
              },
              sections: [
                {
                  title: "Desktop monitors",
                  lines:
                    monitorLines.length > 0
                      ? monitorLines
                      : ["No monitors detected."],
                },
              ],
              traceLines: [
                `list_ui_monitors() -> ${monitors.length} monitor${monitors.length === 1 ? "" : "s"}`,
              ],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "list_ui_monitors",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        spec: {
          name: "capture_ui_screen",
          description:
            "Capture a monitor or a monitor-relative region as an image for visual inspection. Coordinates are absolute desktop pixels when interpreted with the returned monitor bounds.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              monitorId: {
                type: "integer",
                description:
                  "Optional monitor id from list_ui_monitors. When omitted, the primary monitor is used.",
              },
              x: {
                type: "integer",
                description:
                  "Optional monitor-relative x coordinate for a cropped capture region.",
              },
              y: {
                type: "integer",
                description:
                  "Optional monitor-relative y coordinate for a cropped capture region.",
              },
              width: {
                type: "integer",
                description:
                  "Optional crop width in pixels. Requires x, y, and height as well.",
              },
              height: {
                type: "integer",
                description:
                  "Optional crop height in pixels. Requires x, y, and width as well.",
              },
              maxWidth: {
                type: "integer",
                minimum: 200,
                maximum: 4_096,
                description:
                  "Optional maximum output width. Large captures are scaled down to stay model-friendly.",
              },
              maxHeight: {
                type: "integer",
                minimum: 200,
                maximum: 4_096,
                description:
                  "Optional maximum output height. Large captures are scaled down to stay model-friendly.",
              },
            },
          },
        },
        backingTool: "shell",
        riskLevel: "low",
        execute: async (args, context) => {
          try {
            const captureBounds = normalizeCaptureBounds(args);
            const { maxWidth, maxHeight } = normalizeMaxCaptureSize(args);
            const monitorId = coerceInteger(args, "monitorId");
            const capture =
              await executeDesktopUiBridge<DesktopUiMonitorCapture>(
                context.uiControl,
                "capture_screen",
                {
                  ...(monitorId !== undefined ? { monitorId } : {}),
                  ...(captureBounds ?? {}),
                  maxWidth,
                  maxHeight,
                },
              );
            const summary = [
              `Captured ${capture.monitor.friendlyName} (#${capture.monitor.id})`,
              capture.region
                ? `region (${capture.region.x}, ${capture.region.y}, ${capture.region.width}, ${capture.region.height})`
                : `full monitor ${capture.monitor.width}x${capture.monitor.height}`,
              `output ${capture.image.width}x${capture.image.height}`,
            ].join(" · ");

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "capture_ui_screen",
                output: summary,
                content: createImageToolResultContent(summary, capture.image),
              },
              sections: createCaptureSections(
                "Screen capture",
                [
                  `monitor: ${formatMonitorLine(capture.monitor)}`,
                  ...(capture.region
                    ? [
                        `region: (${capture.region.x}, ${capture.region.y}, ${capture.region.width}, ${capture.region.height})`,
                      ]
                    : ["region: full monitor"]),
                ],
                capture.image,
              ),
              traceLines: [
                `capture_ui_screen(${capture.monitor.id}) -> ${capture.image.width}x${capture.image.height}`,
              ],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "capture_ui_screen",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        spec: {
          name: "list_ui_windows",
          description:
            "List visible desktop windows with titles, apps, bounds, and optional native handles. Use this before capturing or focusing a specific window.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              includeMinimized: {
                type: "boolean",
                description: "Whether minimized windows should be included.",
              },
              titleContains: {
                type: "string",
                description: "Optional case-insensitive title filter.",
              },
              appNameContains: {
                type: "string",
                description: "Optional case-insensitive app-name filter.",
              },
              maxResults: {
                type: "integer",
                minimum: 1,
                maximum: MAX_UI_WINDOW_RESULTS,
                description: "Maximum number of windows to return.",
              },
            },
          },
        },
        backingTool: "shell",
        riskLevel: "low",
        execute: async (args, context) => {
          try {
            const windows = await executeDesktopUiBridge<DesktopUiWindowInfo[]>(
              context.uiControl,
              "list_windows",
            );
            const filteredWindows = filterWindows(windows, args);
            const windowLines = filteredWindows.map(formatWindowLine);
            const output =
              windowLines.length > 0
                ? [
                    `Matched ${filteredWindows.length} window(s):`,
                    ...windowLines,
                  ].join("\n")
                : "No matching windows were found.";

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "list_ui_windows",
                output: limitText(output),
              },
              sections: [
                {
                  title: "Desktop windows",
                  lines:
                    windowLines.length > 0
                      ? windowLines
                      : ["No matching windows found."],
                },
              ],
              traceLines: [
                `list_ui_windows() -> ${filteredWindows.length} window${filteredWindows.length === 1 ? "" : "s"}`,
              ],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "list_ui_windows",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        spec: {
          name: "capture_ui_window",
          description:
            "Capture a specific window as an image for visual inspection. Use list_ui_windows first to discover the window id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              windowId: {
                type: "integer",
                description: "Window id from list_ui_windows.",
              },
              maxWidth: {
                type: "integer",
                minimum: 200,
                maximum: 4_096,
                description:
                  "Optional maximum output width. Large captures are scaled down to stay model-friendly.",
              },
              maxHeight: {
                type: "integer",
                minimum: 200,
                maximum: 4_096,
                description:
                  "Optional maximum output height. Large captures are scaled down to stay model-friendly.",
              },
            },
            required: ["windowId"],
          },
        },
        backingTool: "shell",
        riskLevel: "low",
        execute: async (args, context) => {
          const windowId = coerceInteger(args, "windowId");

          if (windowId === undefined) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "capture_ui_window",
              "Expected an integer `windowId`.",
            );
          }

          try {
            const { maxWidth, maxHeight } = normalizeMaxCaptureSize(args);
            const capture =
              await executeDesktopUiBridge<DesktopUiWindowCapture>(
                context.uiControl,
                "capture_window",
                {
                  windowId,
                  maxWidth,
                  maxHeight,
                },
              );
            const summary = [
              `Captured ${capture.window.title || "(untitled window)"}`,
              `app ${capture.window.appName || "unknown"}`,
              `output ${capture.image.width}x${capture.image.height}`,
            ].join(" · ");

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "capture_ui_window",
                output: summary,
                content: createImageToolResultContent(summary, capture.image),
              },
              sections: createCaptureSections(
                "Window capture",
                [formatWindowLine(capture.window)],
                capture.image,
              ),
              traceLines: [
                `capture_ui_window(${windowId}) -> ${capture.image.width}x${capture.image.height}`,
              ],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "capture_ui_window",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
    );
  }

  toolDefinitions.push(
    {
      spec: {
        name: "click_ui_point",
        description:
          "Move the mouse to an absolute desktop coordinate and click there. Capture first, then click, then recapture to verify the result.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            x: {
              type: "integer",
              description: "Absolute desktop x coordinate in pixels.",
            },
            y: {
              type: "integer",
              description: "Absolute desktop y coordinate in pixels.",
            },
            button: {
              type: "string",
              enum: ["left", "right", "middle"],
              description: "Mouse button to click.",
            },
            clickCount: {
              type: "integer",
              minimum: 1,
              maximum: 3,
              description: "Number of clicks to perform.",
            },
          },
          required: ["x", "y"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const x = coerceInteger(args, "x");
        const y = coerceInteger(args, "y");
        const button = coerceString(args, "button") ?? "left";
        const clickCount = coerceInteger(args, "clickCount") ?? 1;

        if (x === undefined || y === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "click_ui_point",
            "Expected integer `x` and `y` coordinates.",
          );
        }

        try {
          await executeDesktopUiBridge<Record<string, unknown>>(
            context.uiControl,
            "click_point",
            {
              x,
              y,
              button,
              clickCount,
            },
          );

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "click_ui_point",
              output: `Clicked ${button} mouse button ${clickCount} time(s) at (${x}, ${y}).`,
            },
            sections: [
              {
                title: "UI pointer action",
                lines: [
                  `action: click`,
                  `button: ${button}`,
                  `count: ${clickCount}`,
                  `position: (${x}, ${y})`,
                ],
              },
            ],
            traceLines: [
              `click_ui_point(${x}, ${y}, ${button}, count=${clickCount})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "click_ui_point",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "drag_ui_pointer",
        description:
          "Press the mouse button at one absolute desktop coordinate, drag to another coordinate, and release. Use this for sliders, splitters, selection boxes, or drag-and-drop.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            startX: {
              type: "integer",
              description: "Absolute desktop start x coordinate in pixels.",
            },
            startY: {
              type: "integer",
              description: "Absolute desktop start y coordinate in pixels.",
            },
            endX: {
              type: "integer",
              description: "Absolute desktop end x coordinate in pixels.",
            },
            endY: {
              type: "integer",
              description: "Absolute desktop end y coordinate in pixels.",
            },
            button: {
              type: "string",
              enum: ["left", "right", "middle"],
              description: "Mouse button to use for the drag.",
            },
          },
          required: ["startX", "startY", "endX", "endY"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const startX = coerceInteger(args, "startX");
        const startY = coerceInteger(args, "startY");
        const endX = coerceInteger(args, "endX");
        const endY = coerceInteger(args, "endY");
        const button = coerceString(args, "button") ?? "left";

        if (
          startX === undefined ||
          startY === undefined ||
          endX === undefined ||
          endY === undefined
        ) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "drag_ui_pointer",
            "Expected integer `startX`, `startY`, `endX`, and `endY` coordinates.",
          );
        }

        try {
          await executeDesktopUiBridge<Record<string, unknown>>(
            context.uiControl,
            "drag_pointer",
            {
              startX,
              startY,
              endX,
              endY,
              button,
            },
          );

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "drag_ui_pointer",
              output: `Dragged ${button} mouse button from (${startX}, ${startY}) to (${endX}, ${endY}).`,
            },
            sections: [
              {
                title: "UI pointer action",
                lines: [
                  `action: drag`,
                  `button: ${button}`,
                  `from: (${startX}, ${startY})`,
                  `to: (${endX}, ${endY})`,
                ],
              },
            ],
            traceLines: [
              `drag_ui_pointer(${startX}, ${startY}) -> (${endX}, ${endY})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "drag_ui_pointer",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "type_ui_text",
        description:
          "Type literal text into the currently focused control. Use click_ui_point or focus_ui_window first when needed.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Literal text to type into the focused UI element.",
            },
          },
          required: ["text"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const text = typeof args.text === "string" ? args.text : undefined;

        if (!text || text.length === 0) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "type_ui_text",
            "Expected a non-empty `text` string.",
          );
        }

        try {
          await executeDesktopUiBridge<Record<string, unknown>>(
            context.uiControl,
            "type_text",
            { text },
          );

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "type_ui_text",
              output: `Typed text into the focused UI element: ${compactTraceText(text)}`,
            },
            sections: [createTextSection("Typed UI text", text, 10)],
            traceLines: [`type_ui_text(${compactTraceText(text)})`],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "type_ui_text",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "press_ui_keys",
        description:
          "Press one or more keys as a chord, such as ['Control', 'L'] or ['Alt', 'Tab']. Use this for keyboard navigation, shortcuts, and non-text input.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            keys: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "string",
              },
              description:
                "Ordered list of key names, for example ['Control', 'L'] or ['Shift', 'Tab'].",
            },
          },
          required: ["keys"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const keys = normalizeUiKeyList(args.keys);

        if (!keys) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "press_ui_keys",
            "Expected a non-empty string array `keys`.",
          );
        }

        try {
          await executeDesktopUiBridge<Record<string, unknown>>(
            context.uiControl,
            "press_keys",
            { keys },
          );

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "press_ui_keys",
              output: `Pressed UI key chord: ${keys.join(" + ")}`,
            },
            sections: [
              {
                title: "UI keyboard action",
                lines: [`keys: ${keys.join(" + ")}`],
              },
            ],
            traceLines: [`press_ui_keys(${keys.join("+")})`],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "press_ui_keys",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "wait_for_ui_duration",
        description:
          "Pause briefly so an app can open, render, navigate, or finish an animation before the next capture or input step.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            milliseconds: {
              type: "integer",
              minimum: 100,
              maximum: MAX_UI_WAIT_TIMEOUT_MS,
              description: "How long to wait in milliseconds.",
            },
          },
          required: ["milliseconds"],
        },
      },
      backingTool: "shell",
      riskLevel: "low",
      execute: async (args) => {
        const milliseconds = coerceInteger(args, "milliseconds");

        if (milliseconds === undefined || milliseconds < 100) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "wait_for_ui_duration",
            "Expected `milliseconds` to be an integer >= 100.",
          );
        }

        await sleep(Math.min(milliseconds, MAX_UI_WAIT_TIMEOUT_MS));

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "wait_for_ui_duration",
            output: `Waited ${milliseconds}ms for the desktop UI to settle.`,
          },
          sections: [
            {
              title: "UI wait",
              lines: [`duration: ${milliseconds}ms`],
            },
          ],
          traceLines: [`wait_for_ui_duration(${milliseconds}ms)`],
        };
      },
    },
    {
      spec: {
        name: "wait_for_ui_window",
        description:
          "Poll the desktop until a matching window appears or the timeout expires. Use this after launching or switching apps instead of guessing whether they are ready.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            titleContains: {
              type: "string",
              description:
                "Optional case-insensitive title substring to match.",
            },
            appNameContains: {
              type: "string",
              description:
                "Optional case-insensitive app-name substring to match.",
            },
            includeMinimized: {
              type: "boolean",
              description: "Whether minimized windows may satisfy the wait.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 200,
              maximum: MAX_UI_WAIT_TIMEOUT_MS,
              description: "Maximum time to wait before timing out.",
            },
            pollIntervalMs: {
              type: "integer",
              minimum: 100,
              maximum: MAX_UI_WAIT_POLL_INTERVAL_MS,
              description: "How often to poll for a matching window.",
            },
          },
        },
      },
      backingTool: "shell",
      riskLevel: "low",
      execute: async (args, context) => {
        const timeoutMs =
          coerceInteger(args, "timeoutMs") ?? DEFAULT_UI_WAIT_TIMEOUT_MS;
        const pollIntervalMs =
          coerceInteger(args, "pollIntervalMs") ??
          DEFAULT_UI_WAIT_POLL_INTERVAL_MS;
        const titleContains = coerceString(args, "titleContains");
        const appNameContains = coerceString(args, "appNameContains");

        if (!titleContains && !appNameContains) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "wait_for_ui_window",
            "Expected at least one of `titleContains` or `appNameContains`.",
          );
        }

        const startedAt = Date.now();

        try {
          while (Date.now() - startedAt <= timeoutMs) {
            const windows = await executeDesktopUiBridge<DesktopUiWindowInfo[]>(
              context.uiControl,
              "list_windows",
            );
            const matches = filterWindows(windows, {
              ...args,
              ...(titleContains ? { titleContains } : {}),
              ...(appNameContains ? { appNameContains } : {}),
              maxResults: MAX_UI_WINDOW_RESULTS,
            });

            if (matches.length > 0) {
              const lines = matches.map(formatWindowLine);

              return {
                toolResult: {
                  callId: crypto.randomUUID(),
                  name: "wait_for_ui_window",
                  output: `Found ${matches.length} matching window(s) after ${Date.now() - startedAt}ms.`,
                },
                sections: [
                  {
                    title: "Matching windows",
                    lines,
                  },
                ],
                traceLines: [
                  `wait_for_ui_window(${titleContains ?? appNameContains ?? "window"}) -> ${matches.length} match${matches.length === 1 ? "" : "es"}`,
                ],
              };
            }

            await sleep(pollIntervalMs);
          }

          return createToolErrorResult(
            crypto.randomUUID(),
            "wait_for_ui_window",
            `No matching window appeared within ${timeoutMs}ms.`,
          );
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "wait_for_ui_window",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
  );

  if (availableUiControl.platform === "windows") {
    toolDefinitions.push(
      {
        spec: {
          name: "focus_ui_window",
          description:
            "Restore and bring a desktop window to the foreground on Windows. Use this before typing or handle-based control when the wrong app has focus.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              windowId: {
                type: "integer",
                description: "Window id from list_ui_windows.",
              },
            },
            required: ["windowId"],
          },
        },
        backingTool: "shell",
        riskLevel: "medium",
        execute: async (args, context) => {
          const windowId = coerceInteger(args, "windowId");

          if (windowId === undefined) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "focus_ui_window",
              "Expected an integer `windowId`.",
            );
          }

          try {
            const focusedWindow =
              await executeDesktopUiBridge<DesktopUiWindowInfo>(
                context.uiControl,
                "focus_window",
                { windowId },
              );

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "focus_ui_window",
                output: `Focused window: ${focusedWindow.title || "(untitled window)"}`,
              },
              sections: [
                {
                  title: "Focused window",
                  lines: [formatWindowLine(focusedWindow)],
                },
              ],
              traceLines: [`focus_ui_window(${windowId})`],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "focus_ui_window",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        spec: {
          name: "list_windows_controls",
          description:
            "Enumerate child controls for a Windows desktop window by native handle. Use this before handle-based button clicks or text injection.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              windowHandle: {
                type: "string",
                description:
                  "Native window handle from list_ui_windows, for example 0x0000000000123456.",
              },
            },
            required: ["windowHandle"],
          },
        },
        backingTool: "shell",
        riskLevel: "low",
        execute: async (args, context) => {
          const windowHandle = coerceString(args, "windowHandle");

          if (!windowHandle) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "list_windows_controls",
              "Expected a string `windowHandle`.",
            );
          }

          try {
            const controls = await executeDesktopUiBridge<
              DesktopUiWindowControlInfo[]
            >(context.uiControl, "list_window_controls", { windowHandle });
            const lines = controls.map(formatControlLine);
            const output =
              lines.length > 0
                ? [`Detected ${controls.length} control(s):`, ...lines].join(
                    "\n",
                  )
                : `No child controls were found for ${windowHandle}.`;

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "list_windows_controls",
                output: limitText(output),
              },
              sections: [
                {
                  title: "Windows child controls",
                  lines:
                    lines.length > 0 ? lines : ["No child controls found."],
                },
              ],
              traceLines: [
                `list_windows_controls(${windowHandle}) -> ${controls.length} control${controls.length === 1 ? "" : "s"}`,
              ],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "list_windows_controls",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        spec: {
          name: "click_windows_control",
          description:
            "Activate a Windows child control by handle. The bridge prefers a handle-based click and falls back to a mouse click at the control center when necessary.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              controlHandle: {
                type: "string",
                description: "Child control handle from list_windows_controls.",
              },
            },
            required: ["controlHandle"],
          },
        },
        backingTool: "shell",
        riskLevel: "high",
        execute: async (args, context) => {
          const controlHandle = coerceString(args, "controlHandle");

          if (!controlHandle) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "click_windows_control",
              "Expected a string `controlHandle`.",
            );
          }

          try {
            const result =
              await executeDesktopUiBridge<DesktopUiWindowControlInfo>(
                context.uiControl,
                "click_window_control",
                { controlHandle },
              );

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "click_windows_control",
                output: `Activated Windows control ${controlHandle}.`,
              },
              sections: [
                {
                  title: "Windows control action",
                  lines: [formatControlLine(result)],
                },
              ],
              traceLines: [`click_windows_control(${controlHandle})`],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "click_windows_control",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        spec: {
          name: "set_windows_control_text",
          description:
            "Set text directly on a Windows child control by handle. Use this for classic Win32 edit fields when handle-based targeting is more reliable than typing.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              controlHandle: {
                type: "string",
                description: "Child control handle from list_windows_controls.",
              },
              text: {
                type: "string",
                description: "The text value to assign to the control.",
              },
            },
            required: ["controlHandle", "text"],
          },
        },
        backingTool: "shell",
        riskLevel: "high",
        execute: async (args, context) => {
          const controlHandle = coerceString(args, "controlHandle");
          const text = typeof args.text === "string" ? args.text : undefined;

          if (!controlHandle || text === undefined) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "set_windows_control_text",
              "Expected `controlHandle` and `text`.",
            );
          }

          try {
            const result =
              await executeDesktopUiBridge<DesktopUiWindowControlInfo>(
                context.uiControl,
                "set_window_control_text",
                { controlHandle, text },
              );

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "set_windows_control_text",
                output: `Set Windows control text on ${controlHandle}.`,
              },
              sections: [
                {
                  title: "Windows control action",
                  lines: [formatControlLine(result)],
                },
                createTextSection("Control text", text, 10),
              ],
              traceLines: [
                `set_windows_control_text(${controlHandle}, ${compactTraceText(text)})`,
              ],
            };
          } catch (error) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "set_windows_control_text",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
    );
  }

  return toolDefinitions.map((definition) => ({
    ...definition,
    effect: READ_ONLY_DESKTOP_UI_TOOL_NAMES.has(definition.spec.name)
      ? "read"
      : "external-side-effect",
  }));
};

export const createDesktopUiToolDefinitions = (
  uiControl: UiControlRuntimeInfo | undefined,
): AgentToolDefinition[] => {
  try {
    return buildDesktopUiToolDefinitions(uiControl);
  } catch {
    return [];
  }
};
