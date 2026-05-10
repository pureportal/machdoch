import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
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
const MAX_BROWSER_SNAPSHOT_LINES = 80;
const MAX_SELECTOR_LENGTH = 1_000;
const MAX_TYPED_TEXT_LENGTH = 10_000;
const DEFAULT_SCREENSHOT_DIFF_THRESHOLD_PERCENT = 0.1;

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

const BROWSER_LOCATOR_TYPES = [
  "selector",
  "role",
  "text",
  "testId",
  "label",
  "placeholder",
  "title",
  "altText",
] as const;

const BROWSER_WAIT_STRATEGIES = [
  "load-state",
  "locator-visible",
  "locator-hidden",
  "locator-attached",
  "locator-detached",
  "text",
  "url",
  "timeout",
] as const;

type BrowserChannel = (typeof BROWSER_CHANNELS)[number];
type BrowserWaitUntil = (typeof WAIT_UNTIL_VALUES)[number];
type BrowserLocatorType = (typeof BROWSER_LOCATOR_TYPES)[number];
type BrowserWaitStrategy = (typeof BROWSER_WAIT_STRATEGIES)[number];

interface BrowserScreenshotBaseline {
  id: string;
  screenshot: Buffer;
  url: string;
  title: string;
  capturedAt: number;
}

interface BrowserSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  channel: BrowserChannel;
  headless: boolean;
  startedAt: number;
  screenshotBaselines: Map<string, BrowserScreenshotBaseline>;
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

const isBrowserLocatorType = (
  value: string | undefined,
): value is BrowserLocatorType => {
  return (
    value !== undefined &&
    BROWSER_LOCATOR_TYPES.includes(value as BrowserLocatorType)
  );
};

const isBrowserWaitStrategy = (
  value: string | undefined,
): value is BrowserWaitStrategy => {
  return (
    value !== undefined &&
    BROWSER_WAIT_STRATEGIES.includes(value as BrowserWaitStrategy)
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

const coerceBoundedBrowserText = (
  args: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = coerceString(args, field);

  if (!value || value.length > MAX_SELECTOR_LENGTH || value.includes("\0")) {
    return undefined;
  }

  return value;
};

const coerceBaselineId = (args: Record<string, unknown>): string | undefined => {
  const baselineId = coerceString(args, "baselineId");

  return baselineId && /^[a-zA-Z0-9_-]{1,64}$/u.test(baselineId)
    ? baselineId
    : undefined;
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
  const { chromium } = await import("playwright-core");

  for (const channel of channels) {
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({
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
      if (browser) {
        await browser.close().catch(() => undefined);
      }

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

  try {
    await session.context.close({
      reason: "Browser session closed by machdoch.",
    });
  } finally {
    await session.browser.close();
  }
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

const createLocatorGuidanceLines = (): string[] => {
  return [
    "Prefer locatorType=role with locatorValue=<role> and locatorName=<accessible name> for buttons, links, headings, and inputs.",
    "Use locatorType=text for visible copy and locatorType=testId for stable test ids; use raw selector only when semantic locators are unavailable.",
    "Before destructive actions, inspect_browser_locator and/or snapshot_browser_page, then use wait_for_browser_page for explicit post-action waits.",
    "Click and text tools use Playwright locator actionability checks; avoid arbitrary sleeps unless waiting for animations or debounced UI.",
  ];
};

const getLocatorInputSchemaProperties = () => ({
  selector: {
    type: "string",
    description:
      "Legacy raw Playwright selector. Prefer locatorType plus locatorValue when possible.",
  },
  locatorType: {
    type: "string",
    enum: BROWSER_LOCATOR_TYPES,
    description:
      "Preferred target strategy. Use role, text, testId, label, placeholder, title, or altText before selector.",
  },
  locatorValue: {
    type: "string",
    description:
      "Locator value. For role locators this is the ARIA role, such as button, link, textbox, heading, or checkbox.",
  },
  locatorName: {
    type: "string",
    description:
      "Accessible name for role locators, such as the button text or input label.",
  },
  exact: {
    type: "boolean",
    description:
      "Whether text-like locators should match exactly. Defaults to Playwright behavior.",
  },
});

const resolveBrowserLocator = (
  page: Page,
  args: Record<string, unknown>,
): { locator: Locator; summary: string } => {
  const locatorTypeInput = coerceString(args, "locatorType");
  const locatorType = isBrowserLocatorType(locatorTypeInput)
    ? locatorTypeInput
    : undefined;
  const locatorValue = coerceBoundedBrowserText(args, "locatorValue");
  const locatorName = coerceBoundedBrowserText(args, "locatorName");
  const exact = coerceBoolean(args, "exact");
  const textOptions = exact === undefined ? undefined : { exact };

  if (locatorType && locatorType !== "selector") {
    if (!locatorValue) {
      throw new Error(
        "Expected `locatorValue` when `locatorType` is provided.",
      );
    }

    switch (locatorType) {
      case "role": {
        const roleOptions = {
          ...(locatorName ? { name: locatorName } : {}),
          ...(exact === undefined ? {} : { exact }),
        };

        return {
          locator: page.getByRole(
            locatorValue as Parameters<Page["getByRole"]>[0],
            roleOptions,
          ),
          summary: `role=${locatorValue}${locatorName ? ` name=${locatorName}` : ""}`,
        };
      }
      case "text":
        return {
          locator: page.getByText(locatorValue, textOptions),
          summary: `text=${locatorValue}`,
        };
      case "testId":
        return {
          locator: page.getByTestId(locatorValue),
          summary: `testId=${locatorValue}`,
        };
      case "label":
        return {
          locator: page.getByLabel(locatorValue, textOptions),
          summary: `label=${locatorValue}`,
        };
      case "placeholder":
        return {
          locator: page.getByPlaceholder(locatorValue, textOptions),
          summary: `placeholder=${locatorValue}`,
        };
      case "title":
        return {
          locator: page.getByTitle(locatorValue, textOptions),
          summary: `title=${locatorValue}`,
        };
      case "altText":
        return {
          locator: page.getByAltText(locatorValue, textOptions),
          summary: `altText=${locatorValue}`,
        };
    }
  }

  const selector = locatorType === "selector" && locatorValue
    ? locatorValue
    : coerceSelector(args);

  if (!selector) {
    throw new Error(
      "Expected a semantic locator (`locatorType` and `locatorValue`) or a bounded raw `selector`.",
    );
  }

  return {
    locator: page.locator(selector),
    summary: `selector=${selector}`,
  };
};

const maybeCallLocatorBoolean = async (
  locator: Locator,
  method: "isVisible" | "isEnabled" | "isEditable",
  timeoutMs: number,
): Promise<boolean | "unknown"> => {
  try {
    return await locator[method]({ timeout: timeoutMs });
  } catch {
    return "unknown";
  }
};

const formatBooleanState = (value: boolean | "unknown"): string => {
  return value === "unknown" ? "unknown" : value ? "yes" : "no";
};

const inspectLocatorActionability = async (
  locator: Locator,
  timeoutMs: number,
): Promise<{
  count: number;
  visible: boolean | "unknown";
  enabled: boolean | "unknown";
  editable: boolean | "unknown";
  boundingBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  text: string;
}> => {
  const count = await locator.count();
  const first = locator.first();
  const [visible, enabled, editable, boundingBox] = await Promise.all([
    maybeCallLocatorBoolean(first, "isVisible", timeoutMs),
    maybeCallLocatorBoolean(first, "isEnabled", timeoutMs),
    maybeCallLocatorBoolean(first, "isEditable", timeoutMs),
    first.boundingBox({ timeout: timeoutMs }).catch(() => null),
  ]);
  const text = await first.innerText({ timeout: timeoutMs }).catch(() => "");

  return {
    count,
    visible,
    enabled,
    editable,
    boundingBox,
    text: limitText(text, 2_000),
  };
};

const assertLocatorActionable = async (
  locator: Locator,
  timeoutMs: number,
  mode: "click" | "text",
): Promise<void> => {
  await locator.waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  if (mode === "click") {
    const enabled = await locator.isEnabled({ timeout: timeoutMs });

    if (!enabled) {
      throw new Error("Target locator is visible but disabled.");
    }

    return;
  }

  const editable = await locator.isEditable({ timeout: timeoutMs });

  if (!editable) {
    throw new Error("Target locator is visible but not editable.");
  }
};

const createBrowserPageSnapshot = async (
  page: Page,
  timeoutMs: number,
): Promise<string[]> => {
  const title = await page.title();
  const bodyText = await readVisibleBodyText(page, timeoutMs);
  const domLines = await page
    .evaluate<string[]>(`
(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const describe = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    const aria = element.getAttribute("aria-label");
    const text = clean(element.innerText || element.textContent || element.getAttribute("value") || element.getAttribute("placeholder"));
    const bits = [tag];
    if (role) bits.push("role=" + role);
    if (testId) bits.push("testId=" + testId);
    if (aria) bits.push("aria=" + aria);
    if (text) bits.push("text=" + text.slice(0, 120));
    return bits.join(" | ");
  };
  const selectors = [
    "h1", "h2", "h3",
    "button", "[role=button]",
    "a[href]",
    "input", "textarea", "select",
    "[data-testid]", "[data-test-id]",
    "[aria-label]"
  ];
  return Array.from(document.querySelectorAll(selectors.join(",")))
    .map(describe)
    .filter(Boolean)
    .slice(0, ${MAX_BROWSER_SNAPSHOT_LINES});
})()
`)
    .catch(() => []);

  return [
    `url: ${page.url()}`,
    `title: ${title}`,
    ...domLines.map((line) => `element: ${line}`),
    "visible text:",
    ...limitText(bodyText, 8_000).split(/\r?\n/u),
  ];
};

const compareScreenshotBuffers = (
  baseline: Buffer,
  current: Buffer,
): {
  differingBytes: number;
  comparedBytes: number;
  differencePercent: number;
} => {
  const comparedBytes = Math.max(baseline.length, current.length);

  if (comparedBytes === 0) {
    return {
      differingBytes: 0,
      comparedBytes,
      differencePercent: 0,
    };
  }

  let differingBytes = 0;

  for (let index = 0; index < comparedBytes; index += 1) {
    if (baseline[index] !== current[index]) {
      differingBytes += 1;
    }
  }

  return {
    differingBytes,
    comparedBytes,
    differencePercent: (differingBytes / comparedBytes) * 100,
  };
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
      effect: "external-side-effect",
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
            screenshotBaselines: new Map(),
          };
          let didRegisterSession = false;

          browserSessions.set(session.id, session);
          didRegisterSession = true;

          try {
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
            if (didRegisterSession) {
              await closeBrowserSession(session).catch(() => undefined);
            } else {
              await session.browser.close().catch(() => undefined);
            }

            throw error;
          }
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
      effect: "external-side-effect",
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
      effect: "read",
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
          "Capture a PNG screenshot from an open browser session for visual inspection. Use baselineId to store screenshots for later compare_browser_screenshot checks.",
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
            baselineId: {
              type: "string",
              description:
                "Optional stable id to store this screenshot as a comparison baseline for the session.",
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
      effect: "read",
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
          const baselineId = coerceBaselineId(args);
          const screenshot = await session.page.screenshot({
            fullPage: coerceBoolean(args, "fullPage") ?? false,
            timeout: coerceTimeoutMs(args),
            type: "png",
          });
          const title = await session.page.title();

          if (baselineId) {
            session.screenshotBaselines.set(baselineId, {
              id: baselineId,
              screenshot,
              url: session.page.url(),
              title,
              capturedAt: Date.now(),
            });
          }

          const summary = [
            `session: ${session.id}`,
            `url: ${session.page.url()}`,
            `title: ${title}`,
            `bytes: ${screenshot.length}`,
            ...(baselineId ? [`baseline: ${baselineId}`] : []),
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
        name: "snapshot_browser_page",
        description:
          "Create a text snapshot of the current browser page with URL, title, visible text, and key interactive elements. Use this to choose role/text/testId locators before acting.",
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
              description: "Maximum snapshot timeout in milliseconds.",
            },
          },
          required: ["sessionId"],
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");

        if (!sessionId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "snapshot_browser_page",
            "Expected a non-empty `sessionId`.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const lines = await createBrowserPageSnapshot(
            session.page,
            coerceTimeoutMs(args),
          );

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "snapshot_browser_page",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "Browser page snapshot",
                lines: [
                  ...lines.slice(0, MAX_BROWSER_SNAPSHOT_LINES),
                  ...createLocatorGuidanceLines(),
                ],
              },
            ],
            traceLines: [
              `snapshot_browser_page(${session.id}) -> ${lines.length} lines`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "snapshot_browser_page",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "compare_browser_screenshot",
        description:
          "Capture the current page and compare it with a screenshot baseline stored by capture_browser_page. Reports byte-level PNG differences for visual regression checks.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            baselineId: {
              type: "string",
              description:
                "Baseline id previously stored by capture_browser_page.",
            },
            fullPage: {
              type: "boolean",
              description:
                "Whether to capture the full scrollable page before comparison.",
            },
            thresholdPercent: {
              type: "number",
              minimum: 0,
              maximum: 100,
              description:
                "Allowed differing byte percentage before the comparison is marked changed. Defaults to 0.1.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum screenshot timeout in milliseconds.",
            },
          },
          required: ["sessionId", "baselineId"],
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");
        const baselineId = coerceBaselineId(args);

        if (!sessionId || !baselineId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "compare_browser_screenshot",
            "Expected non-empty `sessionId` and valid `baselineId` values.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const baseline = session.screenshotBaselines.get(baselineId);

          if (!baseline) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "compare_browser_screenshot",
              `No screenshot baseline named \`${baselineId}\` exists for session \`${sessionId}\`.`,
            );
          }

          const current = await session.page.screenshot({
            fullPage: coerceBoolean(args, "fullPage") ?? false,
            timeout: coerceTimeoutMs(args),
            type: "png",
          });
          const thresholdPercent =
            typeof args.thresholdPercent === "number" &&
            Number.isFinite(args.thresholdPercent)
              ? Math.min(Math.max(args.thresholdPercent, 0), 100)
              : DEFAULT_SCREENSHOT_DIFF_THRESHOLD_PERCENT;
          const comparison = compareScreenshotBuffers(
            baseline.screenshot,
            current,
          );
          const changed = comparison.differencePercent > thresholdPercent;
          const lines = [
            `session: ${session.id}`,
            `baseline: ${baseline.id}`,
            `baseline url: ${baseline.url}`,
            `current url: ${session.page.url()}`,
            `baseline title: ${baseline.title}`,
            `current title: ${await session.page.title()}`,
            `baseline captured: ${new Date(baseline.capturedAt).toISOString()}`,
            `baseline bytes: ${baseline.screenshot.length}`,
            `current bytes: ${current.length}`,
            `differing bytes: ${comparison.differingBytes}/${comparison.comparedBytes}`,
            `difference: ${comparison.differencePercent.toFixed(3)}%`,
            `threshold: ${thresholdPercent.toFixed(3)}%`,
            `changed: ${changed ? "yes" : "no"}`,
          ];

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "compare_browser_screenshot",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "Browser screenshot comparison",
                lines,
              },
            ],
            traceLines: [
              `compare_browser_screenshot(${session.id}, ${baselineId}) -> ${comparison.differencePercent.toFixed(3)}%`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "compare_browser_screenshot",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "inspect_browser_locator",
        description:
          "Inspect a Playwright locator before acting. Reports match count, visibility, enabled/editable state, bounding box, and text. Prefer this with role/text/testId locators before risky clicks or typing.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            ...getLocatorInputSchemaProperties(),
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum locator inspection timeout in milliseconds.",
            },
          },
          required: ["sessionId"],
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");

        if (!sessionId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "inspect_browser_locator",
            "Expected a non-empty `sessionId`.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const { locator, summary } = resolveBrowserLocator(
            session.page,
            args,
          );
          const inspection = await inspectLocatorActionability(
            locator,
            coerceTimeoutMs(args),
          );
          const box = inspection.boundingBox
            ? `${inspection.boundingBox.x},${inspection.boundingBox.y} ${inspection.boundingBox.width}x${inspection.boundingBox.height}`
            : "none";
          const lines = [
            `session: ${session.id}`,
            `locator: ${summary}`,
            `matches: ${inspection.count}`,
            `visible: ${formatBooleanState(inspection.visible)}`,
            `enabled: ${formatBooleanState(inspection.enabled)}`,
            `editable: ${formatBooleanState(inspection.editable)}`,
            `bounding box: ${box}`,
            ...(inspection.text ? [`text: ${inspection.text}`] : []),
            ...createLocatorGuidanceLines(),
          ];

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "inspect_browser_locator",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "Browser locator inspection",
                lines,
              },
            ],
            traceLines: [
              `inspect_browser_locator(${session.id}, ${compactTraceText(summary)}) -> ${inspection.count}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "inspect_browser_locator",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "wait_for_browser_page",
        description:
          "Wait explicitly for browser state instead of guessing with arbitrary delays. Supports load states, URL changes, visible/hidden/attached/detached locators, visible text, and bounded timeout waits.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            waitFor: {
              type: "string",
              enum: BROWSER_WAIT_STRATEGIES,
              description:
                "Wait strategy. Prefer locator-visible/text/url/load-state over timeout.",
            },
            waitUntil: {
              type: "string",
              enum: WAIT_UNTIL_VALUES,
              description:
                "Load state for waitFor=load-state. Defaults to load; use networkidle sparingly.",
            },
            urlContains: {
              type: "string",
              description: "URL substring required for waitFor=url.",
            },
            text: {
              type: "string",
              description: "Visible text required for waitFor=text.",
            },
            milliseconds: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description:
                "Bounded delay for waitFor=timeout when no event-based wait is possible.",
            },
            ...getLocatorInputSchemaProperties(),
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum explicit wait timeout in milliseconds.",
            },
          },
          required: ["sessionId", "waitFor"],
        },
      },
      backingTool: "browser",
      riskLevel: "low",
      effect: "read",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");
        const waitFor = coerceString(args, "waitFor");

        if (!sessionId || !isBrowserWaitStrategy(waitFor)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "wait_for_browser_page",
            "Expected non-empty `sessionId` and supported `waitFor` strategy.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const timeoutMs = coerceTimeoutMs(args);
          const lines: string[] = [`session: ${session.id}`, `waitFor: ${waitFor}`];

          if (waitFor === "load-state") {
            const waitUntil = coerceString(args, "waitUntil");
            const state =
              isWaitUntil(waitUntil) && waitUntil !== "commit"
                ? waitUntil
                : "load";

            await session.page.waitForLoadState(state, {
              timeout: timeoutMs,
            });
            lines.push(`load state: ${state}`);
          } else if (waitFor === "url") {
            const urlContains = coerceBoundedBrowserText(args, "urlContains");

            if (!urlContains) {
              throw new Error("Expected `urlContains` for waitFor=url.");
            }

            await session.page.waitForURL(
              (url) => url.toString().includes(urlContains),
              { timeout: timeoutMs },
            );
            lines.push(`url contains: ${urlContains}`);
          } else if (waitFor === "text") {
            const text = coerceBoundedBrowserText(args, "text");

            if (!text) {
              throw new Error("Expected `text` for waitFor=text.");
            }

            await session.page.getByText(text).waitFor({
              state: "visible",
              timeout: timeoutMs,
            });
            lines.push(`text: ${text}`);
          } else if (waitFor === "timeout") {
            const milliseconds = Math.min(
              coerceInteger(args, "milliseconds") ?? timeoutMs,
              timeoutMs,
            );

            await session.page.waitForTimeout(milliseconds);
            lines.push(`milliseconds: ${milliseconds}`);
          } else {
            const { locator, summary } = resolveBrowserLocator(
              session.page,
              args,
            );
            const state = waitFor.replace("locator-", "") as
              | "attached"
              | "detached"
              | "hidden"
              | "visible";

            await locator.waitFor({
              state,
              timeout: timeoutMs,
            });
            lines.push(`locator: ${summary}`, `state: ${state}`);
          }

          const summaryLines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "wait_for_browser_page",
              output: [...lines, ...summaryLines].join("\n"),
            },
            sections: [
              {
                title: "Browser explicit wait",
                lines: [...lines, ...summaryLines],
              },
            ],
            traceLines: [
              `wait_for_browser_page(${session.id}, ${waitFor})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "wait_for_browser_page",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "click_browser_selector",
        description:
          "Click an element in an open browser session using Playwright locators. Prefer role/text/testId locators over raw selectors. The tool waits for visibility/enabled actionability before clicking; read, snapshot, or capture before and after important clicks.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            ...getLocatorInputSchemaProperties(),
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_BROWSER_TIMEOUT_MS,
              description: "Maximum locator timeout in milliseconds.",
            },
          },
          required: ["sessionId"],
        },
      },
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");

        if (!sessionId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "click_browser_selector",
            "Expected a non-empty `sessionId`.",
          );
        }

        try {
          const session = getBrowserSession(sessionId);
          const { locator, summary } = resolveBrowserLocator(
            session.page,
            args,
          );
          const timeoutMs = coerceTimeoutMs(args);

          await assertLocatorActionable(locator, timeoutMs, "click");
          await locator.click({
            timeout: timeoutMs,
          });

          const lines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "click_browser_selector",
              output: [`Clicked locator: ${summary}`, ...lines].join("\n"),
            },
            sections: [
              {
                title: "Browser click",
                lines: [
                  `locator: ${summary}`,
                  "actionability: visible and enabled",
                  ...lines,
                ],
              },
            ],
            traceLines: [
              `click_browser_selector(${sessionId}, ${compactTraceText(summary)})`,
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
          "Fill or type text into an element in an open browser session using Playwright locators. Prefer label/role/text/testId locators over raw selectors. The tool waits for visibility/editability before entering text.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: {
              type: "string",
              description: "Browser session id from start_browser_session.",
            },
            ...getLocatorInputSchemaProperties(),
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
          required: ["sessionId", "text"],
        },
      },
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      execute: async (args) => {
        const sessionId = coerceString(args, "sessionId");
        const text = typeof args.text === "string" ? args.text : undefined;

        if (
          !sessionId ||
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
          const { locator, summary } = resolveBrowserLocator(
            session.page,
            args,
          );
          const mode = coerceString(args, "mode") === "type" ? "type" : "fill";
          const timeoutMs = coerceTimeoutMs(args);

          await assertLocatorActionable(locator, timeoutMs, "text");
          if (mode === "type") {
            await locator.pressSequentially(text, {
              timeout: timeoutMs,
            });
          } else {
            await locator.fill(text, {
              timeout: timeoutMs,
            });
          }

          const lines = await navigationSummaryLines(session);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "type_browser_text",
              output: [
                `${mode === "type" ? "Typed" : "Filled"} locator: ${summary}`,
                ...lines,
              ].join("\n"),
            },
            sections: [
              {
                title: "Browser text input",
                lines: [
                  `locator: ${summary}`,
                  `mode: ${mode}`,
                  `text length: ${text.length}`,
                  "actionability: visible and editable",
                  ...lines,
                ],
              },
            ],
            traceLines: [
              `type_browser_text(${sessionId}, ${compactTraceText(summary)}, chars=${text.length})`,
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
      effect: "read",
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
      effect: "external-side-effect",
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
