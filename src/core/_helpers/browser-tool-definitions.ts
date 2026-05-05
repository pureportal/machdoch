import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
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

const DEFAULT_VIEWPORT_WIDTH = 1_280;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const MIN_VIEWPORT_SIZE = 320;
const MAX_VIEWPORT_SIZE = 3_840;
const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
const MAX_BROWSER_TIMEOUT_MS = 120_000;
const MAX_BROWSER_TEXT_CHARS = 20_000;
const MAX_SELECTOR_LENGTH = 1_000;
const MAX_TYPED_TEXT_LENGTH = 10_000;

const BROWSER_CHANNELS = [
  "msedge",
  "msedge-beta",
  "msedge-dev",
  "msedge-canary",
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "chromium",
] as const;

const WAIT_UNTIL_VALUES = [
  "load",
  "domcontentloaded",
  "networkidle",
  "commit",
] as const;

type BrowserChannel = (typeof BROWSER_CHANNELS)[number];
type BrowserWaitUntil = (typeof WAIT_UNTIL_VALUES)[number];

interface BrowserSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  channel: BrowserChannel;
  headless: boolean;
  startedAt: number;
}

const browserSessions = new Map<string, BrowserSession>();

const isBrowserChannel = (
  value: string | undefined,
): value is BrowserChannel => {
  return (
    value !== undefined &&
    BROWSER_CHANNELS.includes(value as BrowserChannel)
  );
};

const isWaitUntil = (value: string | undefined): value is BrowserWaitUntil => {
  return (
    value !== undefined &&
    WAIT_UNTIL_VALUES.includes(value as BrowserWaitUntil)
  );
};

const getDefaultBrowserChannels = (): BrowserChannel[] => {
  if (process.platform === "win32") {
    return ["msedge", "chrome"];
  }

  if (process.platform === "darwin") {
    return ["chrome", "msedge"];
  }

  return ["chrome", "msedge", "chromium"];
};

const coerceViewportSize = (
  args: Record<string, unknown>,
  field: string,
  defaultValue: number,
): number => {
  const value = coerceInteger(args, field) ?? defaultValue;

  return Math.min(Math.max(value, MIN_VIEWPORT_SIZE), MAX_VIEWPORT_SIZE);
};

const coerceTimeoutMs = (args: Record<string, unknown>): number => {
  const value = coerceInteger(args, "timeoutMs") ?? DEFAULT_BROWSER_TIMEOUT_MS;

  return Math.min(Math.max(value, 1_000), MAX_BROWSER_TIMEOUT_MS);
};

const coerceSelector = (
  args: Record<string, unknown>,
): string | undefined => {
  const selector = coerceString(args, "selector");

  if (
    !selector ||
    selector.length > MAX_SELECTOR_LENGTH ||
    selector.includes("\0")
  ) {
    return undefined;
  }

  return selector;
};

const coerceBrowserUrl = (
  args: Record<string, unknown>,
  field = "url",
): URL | undefined => {
  const url = coerceString(args, field);

  if (!url) {
    return undefined;
  }

  const parsedUrl = new URL(url);

  if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:" &&
    parsedUrl.href !== "about:blank"
  ) {
    throw new Error(
      "Browser navigation only supports HTTP, HTTPS, and about:blank URLs.",
    );
  }

  return parsedUrl;
};

const createSessionId = (requestedSessionId: string | undefined): string => {
  if (
    requestedSessionId &&
    /^[a-zA-Z0-9_-]{1,64}$/u.test(requestedSessionId)
  ) {
    return requestedSessionId;
  }

  return crypto.randomUUID();
};

const getBrowserSession = (sessionId: string): BrowserSession => {
  const session = browserSessions.get(sessionId);

  if (!session) {
    throw new Error(
      `No browser session named \`${sessionId}\` is currently open.`,
    );
  }

  return session;
};

const launchInstalledChromium = async (
  requestedChannel: BrowserChannel | undefined,
  headless: boolean,
  viewport: { width: number; height: number },
): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  channel: BrowserChannel;
}> => {
  const channels = requestedChannel
    ? [requestedChannel]
    : getDefaultBrowserChannels();
  const errors: string[] = [];

  for (const channel of channels) {
    try {
      const browser = await chromium.launch({
        channel,
        headless,
      });
      const context = await browser.newContext({
        viewport,
      });
      const page = await context.newPage();

      return {
        browser,
        context,
        page,
        channel,
      };
    } catch (error) {
      errors.push(
        `${channel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    [
      "Could not launch an installed Chromium-based browser.",
      "Install Microsoft Edge or Google Chrome, or pass an installed channel explicitly.",
      ...errors,
    ].join("\n"),
  );
};

const closeBrowserSession = async (session: BrowserSession): Promise<void> => {
  browserSessions.delete(session.id);
  await session.context.close({
    reason: "Browser session closed by machdoch.",
  });
  await session.browser.close();
};

const closeAllBrowserSessions = async (): Promise<number> => {
  const sessions = [...browserSessions.values()];

  await Promise.all(sessions.map((session) => closeBrowserSession(session)));

  return sessions.length;
};

export const closeAllBrowserSessionsForTests = closeAllBrowserSessions;

const navigationSummaryLines = async (
  session: BrowserSession,
): Promise<string[]> => {
  return [
    `session: ${session.id}`,
    `channel: ${session.channel}`,
    `url: ${session.page.url()}`,
    `title: ${await session.page.title()}`,
  ];
};

const readVisibleBodyText = async (
  page: Page,
  timeoutMs: number,
): Promise<string> => {
  try {
    return await page.locator("body").innerText({
      timeout: timeoutMs,
    });
  } catch {
    return (await page.textContent("body", { timeout: timeoutMs })) ?? "";
  }
};

const formatSessionLine = (session: BrowserSession): string => {
  return [
    `${session.id}`,
    `channel=${session.channel}`,
    `headless=${session.headless ? "yes" : "no"}`,
    `url=${session.page.url()}`,
    `started=${new Date(session.startedAt).toISOString()}`,
  ].join(" · ");
};

export const createBrowserToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "start_browser_session",
        description:
          "Launch an installed Chromium-based browser through Playwright and create a browser session. Uses installed Chrome or Edge channels and does not download browser binaries.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description:
                "Optional stable session id with letters, numbers, underscores, or dashes.",
            },
            channel: {
              type: "string",
              enum: BROWSER_CHANNELS,
              description:
                "Optional installed browser channel, such as msedge or chrome. Defaults to platform-specific installed-browser fallbacks.",
            },
            headless: {
              type: "boolean",
              description:
                "Whether to run without a visible browser window. Defaults to true.",
            },
            url: {
              type: "string",
              description:
                "Optional HTTP, HTTPS, or about:blank URL to navigate to immediately after launch.",
            },
            viewportWidth: {
              type: "integer",
              minimum: MIN_VIEWPORT_SIZE,
              maximum: MAX_VIEWPORT_SIZE,
              description: "Browser viewport width in CSS pixels.",
            },
            viewportHeight: {
              type: "integer",
              minimum: MIN_VIEWPORT_SIZE,
              maximum: MAX_VIEWPORT_SIZE,
              description: "Browser viewport height in CSS pixels.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum launch/navigation timeout in milliseconds.",
            },
          },
        },
      },
      backingTool: "browser",
      riskLevel: "high",
      execute: async (args) => {
        const requestedChannel = coerceString(args, "channel");

        if (requestedChannel && !isBrowserChannel(requestedChannel)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_browser_session",
            "Expected `channel` to be a supported installed Chrome or Edge channel.",
          );
        }
        const browserChannel = isBrowserChannel(requestedChannel)
          ? requestedChannel
          : undefined;

        let url: URL | undefined;

        try {
          url = coerceBrowserUrl(args);
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_browser_session",
            error instanceof Error ? error.message : String(error),
          );
        }

        const sessionId = createSessionId(coerceString(args, "sessionId"));

        if (browserSessions.has(sessionId)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_browser_session",
            `A browser session named \`${sessionId}\` is already open.`,
          );
        }

        try {
          const viewport = {
            width: coerceViewportSize(
              args,
              "viewportWidth",
              DEFAULT_VIEWPORT_WIDTH,
            ),
            height: coerceViewportSize(
              args,
              "viewportHeight",
              DEFAULT_VIEWPORT_HEIGHT,
            ),
          };
          const launched = await launchInstalledChromium(
            browserChannel,
            coerceBoolean(args, "headless") ?? true,
            viewport,
          );
          const session: BrowserSession = {
            id: sessionId,
            ...launched,
            headless: coerceBoolean(args, "headless") ?? true,
            startedAt: Date.now(),
          };

          browserSessions.set(session.id, session);

          if (url) {
            await session.page.goto(url.toString(), {
              waitUntil: "load",
              timeout: coerceTimeoutMs(args),
            });
          }

          const lines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "start_browser_session",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "Browser session",
                lines: [
                  ...lines,
                  `headless: ${session.headless ? "yes" : "no"}`,
                  `viewport: ${viewport.width}x${viewport.height}`,
                ],
              },
            ],
            traceLines: [
              `start_browser_session(${session.id}, ${session.channel})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_browser_session",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "navigate_browser_page",
        description:
          "Navigate an open browser session to an HTTP, HTTPS, or about:blank URL and wait for the requested load state.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            url: {
              type: "string",
              description: "HTTP, HTTPS, or about:blank URL to open.",
            },
            waitUntil: {
              type: "string",
              enum: WAIT_UNTIL_VALUES,
              description:
                "Navigation wait condition. Defaults to load; use networkidle sparingly.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum navigation timeout in milliseconds.",
            },
          },
          required: ["sessionId", "url"],
        },
      },
      backingTool: "browser",
      riskLevel: "medium",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");

        if (!sessionId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "navigate_browser_page",
            "Expected a non-empty `sessionId`.",
          );
        }

        let url: URL;

        try {
          const parsedUrl = coerceBrowserUrl(args);

          if (!parsedUrl) {
            throw new Error("Expected a non-empty `url`.");
          }

          url = parsedUrl;
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "navigate_browser_page",
            error instanceof Error ? error.message : String(error),
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const waitUntil = coerceString(args, "waitUntil");

          await session.page.goto(url.toString(), {
            waitUntil: isWaitUntil(waitUntil) ? waitUntil : "load",
            timeout: coerceTimeoutMs(args),
          });

          const lines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "navigate_browser_page",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "Browser navigation",
                lines,
              },
            ],
            traceLines: [
              `navigate_browser_page(${sessionId}, ${url.toString()})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "navigate_browser_page",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "read_browser_page",
        description:
          "Read title, current URL, and visible body text from an open browser session. Use this after navigation or UI actions to inspect state without taking a screenshot.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum text extraction timeout in milliseconds.",
            },
          },
          required: ["sessionId"],
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");

        if (!sessionId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_browser_page",
            "Expected a non-empty `sessionId`.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const title = await session.page.title();
          const bodyText = await readVisibleBodyText(
            session.page,
            coerceTimeoutMs(args),
          );
          const limitedBodyText = limitText(bodyText, MAX_BROWSER_TEXT_CHARS);
          const output = [
            `Session: ${session.id}`,
            `URL: ${session.page.url()}`,
            `Title: ${title}`,
            limitedBodyText,
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "read_browser_page",
              output,
            },
            sections: [
              {
                title: "Browser page",
                lines: [
                  `session: ${session.id}`,
                  `url: ${session.page.url()}`,
                  `title: ${title}`,
                ],
              },
              createTextSection("Visible page text", limitedBodyText),
            ],
            traceLines: [
              `read_browser_page(${session.id}) -> ${bodyText.length} chars`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_browser_page",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "capture_browser_page",
        description:
          "Capture a PNG screenshot from an open browser session for visual inspection.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            fullPage: {
              type: "boolean",
              description:
                "Whether to capture the full scrollable page instead of only the viewport.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum screenshot timeout in milliseconds.",
            },
          },
          required: ["sessionId"],
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");

        if (!sessionId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "capture_browser_page",
            "Expected a non-empty `sessionId`.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const screenshot = await session.page.screenshot({
            fullPage: coerceBoolean(args, "fullPage") ?? false,
            timeout: coerceTimeoutMs(args),
            type: "png",
          });
          const summary = [
            `session: ${session.id}`,
            `url: ${session.page.url()}`,
            `title: ${await session.page.title()}`,
            `bytes: ${screenshot.length}`,
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "capture_browser_page",
              output: summary,
              content: [
                {
                  type: "text",
                  text: summary,
                },
                {
                  type: "image",
                  mediaType: "image/png",
                  data: screenshot.toString("base64"),
                  detail: "original",
                },
              ],
            },
            sections: [
              {
                title: "Browser screenshot",
                lines: summary.split("\n"),
              },
            ],
            traceLines: [
              `capture_browser_page(${session.id}) -> ${screenshot.length} bytes`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "capture_browser_page",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "click_browser_selector",
        description:
          "Click an element in an open browser session using a Playwright selector. Read or capture the page before and after important clicks.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            selector: {
              type: "string",
              description:
                "Playwright selector for the target element, such as text=Submit or css=button[type=submit].",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum locator timeout in milliseconds.",
            },
          },
          required: ["sessionId", "selector"],
        },
      },
      backingTool: "browser",
      riskLevel: "high",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");
        const selector = coerceSelector(args);

        if (!sessionId || !selector) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "click_browser_selector",
            "Expected non-empty `sessionId` and bounded `selector` values.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);

          await session.page.locator(selector).click({
            timeout: coerceTimeoutMs(args),
          });

          const lines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "click_browser_selector",
              output: [`Clicked selector: ${selector}`, ...lines].join("\n"),
            },
            sections: [
              {
                title: "Browser click",
                lines: [`selector: ${selector}`, ...lines],
              },
            ],
            traceLines: [
              `click_browser_selector(${sessionId}, ${compactTraceText(selector)})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "click_browser_selector",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "type_browser_text",
        description:
          "Fill or type text into an element in an open browser session using a Playwright selector.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            selector: {
              type: "string",
              description:
                "Playwright selector for the target input, textarea, or editable element.",
            },
            text: {
              type: "string",
              description: "Text to enter into the selected element.",
            },
            mode: {
              type: "string",
              enum: ["fill", "type"],
              description:
                "fill replaces the current value; type simulates keystrokes. Defaults to fill.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum locator timeout in milliseconds.",
            },
          },
          required: ["sessionId", "selector", "text"],
        },
      },
      backingTool: "browser",
      riskLevel: "high",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");
        const selector = coerceSelector(args);
        const text = typeof args.text === "string" ? args.text : undefined;

        if (
          !sessionId ||
          !selector ||
          text === undefined ||
          text.length > MAX_TYPED_TEXT_LENGTH ||
          text.includes("\0")
        ) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "type_browser_text",
            "Expected `sessionId`, bounded `selector`, and bounded string `text`.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const locator = session.page.locator(selector);
          const mode = coerceString(args, "mode") === "type" ? "type" : "fill";

          if (mode === "type") {
            await locator.pressSequentially(text, {
              timeout: coerceTimeoutMs(args),
            });
          } else {
            await locator.fill(text, {
              timeout: coerceTimeoutMs(args),
            });
          }

          const lines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "type_browser_text",
              output: [
                `${mode === "type" ? "Typed" : "Filled"} selector: ${selector}`,
                ...lines,
              ].join("\n"),
            },
            sections: [
              {
                title: "Browser text input",
                lines: [
                  `selector: ${selector}`,
                  `mode: ${mode}`,
                  `text length: ${text.length}`,
                  ...lines,
                ],
              },
            ],
            traceLines: [
              `type_browser_text(${sessionId}, ${compactTraceText(selector)}, chars=${text.length})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "type_browser_text",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "list_browser_sessions",
        description:
          "List open browser sessions and their current URLs.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      execute: async () => {
        const lines = [...browserSessions.values()].map(formatSessionLine);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "list_browser_sessions",
            output:
              lines.length > 0
                ? lines.join("\n")
                : "No browser sessions are open.",
          },
          sections: [
            {
              title: "Browser sessions",
              lines:
                lines.length > 0 ? lines : ["No browser sessions are open."],
            },
          ],
          traceLines: [
            `list_browser_sessions() -> ${lines.length} session${lines.length === 1 ? "" : "s"}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "close_browser_session",
        description:
          "Close one browser session, or all browser sessions when closeAll is true.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description:
                "Browser session id from start_browser_session. Required unless closeAll is true.",
            },
            closeAll: {
              type: "boolean",
              description: "Whether to close every open browser session.",
            },
          },
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      execute: async (args) => {
        const closeAll = coerceBoolean(args, "closeAll") ?? false;
        const sessionId = coerceString(args, "sessionId");

        try {
          if (closeAll) {
            const closedCount = await closeAllBrowserSessions();

            return {
              toolResult: {
                callId: crypto.randomUUID(),
                name: "close_browser_session",
                output: `Closed ${closedCount} browser session${closedCount === 1 ? "" : "s"}.`,
              },
              sections: [
                {
                  title: "Closed browser sessions",
                  lines: [`count: ${closedCount}`],
                },
              ],
              traceLines: [
                `close_browser_session(all) -> ${closedCount} closed`,
              ],
            };
          }

          if (!sessionId) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "close_browser_session",
              "Expected `sessionId` unless `closeAll` is true.",
            );
          }

          const session = getBrowserSession(sessionId);
          await closeBrowserSession(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "close_browser_session",
              output: `Closed browser session ${sessionId}.`,
            },
            sections: [
              {
                title: "Closed browser session",
                lines: [`session: ${sessionId}`],
              },
            ],
            traceLines: [`close_browser_session(${sessionId})`],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "close_browser_session",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
  ];
};
