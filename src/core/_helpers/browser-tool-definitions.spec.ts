/// <reference types="vitest/globals" />

import type { AgentToolExecutionContext } from "./agent-tools-shared.js";

type AsyncUnknownFunction<T> = (...args: unknown[]) => Promise<T>;

interface MockLocator {
  innerText: ReturnType<typeof vi.fn<AsyncUnknownFunction<string>>>;
  click: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
  fill: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
  pressSequentially: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
  waitFor: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
  count: ReturnType<typeof vi.fn<AsyncUnknownFunction<number>>>;
  first: ReturnType<typeof vi.fn<() => MockLocator>>;
  isVisible: ReturnType<typeof vi.fn<AsyncUnknownFunction<boolean>>>;
  isEnabled: ReturnType<typeof vi.fn<AsyncUnknownFunction<boolean>>>;
  isEditable: ReturnType<typeof vi.fn<AsyncUnknownFunction<boolean>>>;
  boundingBox: ReturnType<
    typeof vi.fn<
      AsyncUnknownFunction<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>
    >
  >;
}

interface MockPage {
  goto: ReturnType<typeof vi.fn<AsyncUnknownFunction<null>>>;
  title: ReturnType<typeof vi.fn<AsyncUnknownFunction<string>>>;
  url: ReturnType<typeof vi.fn<() => string>>;
  locator: ReturnType<typeof vi.fn<(selector: string) => MockLocator>>;
  getByRole: ReturnType<typeof vi.fn<(...args: unknown[]) => MockLocator>>;
  getByText: ReturnType<typeof vi.fn<(...args: unknown[]) => MockLocator>>;
  getByTestId: ReturnType<typeof vi.fn<(...args: unknown[]) => MockLocator>>;
  getByLabel: ReturnType<typeof vi.fn<(...args: unknown[]) => MockLocator>>;
  getByPlaceholder: ReturnType<
    typeof vi.fn<(...args: unknown[]) => MockLocator>
  >;
  getByTitle: ReturnType<typeof vi.fn<(...args: unknown[]) => MockLocator>>;
  getByAltText: ReturnType<typeof vi.fn<(...args: unknown[]) => MockLocator>>;
  textContent: ReturnType<
    typeof vi.fn<(...args: unknown[]) => Promise<string | null>>
  >;
  screenshot: ReturnType<typeof vi.fn<AsyncUnknownFunction<Buffer>>>;
  evaluate: ReturnType<typeof vi.fn<AsyncUnknownFunction<string[]>>>;
  waitForLoadState: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
  waitForURL: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
  waitForTimeout: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
}

interface MockContext {
  newPage: ReturnType<typeof vi.fn<AsyncUnknownFunction<MockPage>>>;
  close: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
}

interface MockBrowser {
  newContext: ReturnType<typeof vi.fn<AsyncUnknownFunction<MockContext>>>;
  close: ReturnType<typeof vi.fn<AsyncUnknownFunction<void>>>;
}

const { chromiumLaunchMock } = vi.hoisted(() => ({
  chromiumLaunchMock: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: chromiumLaunchMock,
  },
}));

import {
  closeAllBrowserSessionsForTests,
  createBrowserToolDefinitions,
} from "./browser-tool-definitions.ts";

const createExecutionContext = (): AgentToolExecutionContext => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
  };
};

const createMockLocator = (): MockLocator => {
  const locator = {
    innerText: vi.fn<AsyncUnknownFunction<string>>().mockResolvedValue(
      "Visible page text",
    ),
    click: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
    fill: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
    pressSequentially: vi
      .fn<AsyncUnknownFunction<void>>()
      .mockResolvedValue(undefined),
    waitFor: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
    count: vi.fn<AsyncUnknownFunction<number>>().mockResolvedValue(1),
    first: vi.fn<() => MockLocator>(),
    isVisible: vi.fn<AsyncUnknownFunction<boolean>>().mockResolvedValue(true),
    isEnabled: vi.fn<AsyncUnknownFunction<boolean>>().mockResolvedValue(true),
    isEditable: vi.fn<AsyncUnknownFunction<boolean>>().mockResolvedValue(true),
    boundingBox: vi
      .fn<
        AsyncUnknownFunction<{
          x: number;
          y: number;
          width: number;
          height: number;
        } | null>
      >()
      .mockResolvedValue({
        x: 12,
        y: 24,
        width: 120,
        height: 32,
      }),
  };

  locator.first.mockReturnValue(locator);

  return locator;
};

const createMockBrowserStack = () => {
  const locator = createMockLocator();
  const page: MockPage = {
    goto: vi.fn<AsyncUnknownFunction<null>>().mockResolvedValue(null),
    title: vi.fn<AsyncUnknownFunction<string>>().mockResolvedValue(
      "Example Domain",
    ),
    url: vi.fn<() => string>().mockReturnValue("https://example.com/"),
    locator: vi.fn<(selector: string) => MockLocator>().mockReturnValue(locator),
    getByRole: vi.fn<(...args: unknown[]) => MockLocator>().mockReturnValue(locator),
    getByText: vi.fn<(...args: unknown[]) => MockLocator>().mockReturnValue(locator),
    getByTestId: vi
      .fn<(...args: unknown[]) => MockLocator>()
      .mockReturnValue(locator),
    getByLabel: vi.fn<(...args: unknown[]) => MockLocator>().mockReturnValue(locator),
    getByPlaceholder: vi
      .fn<(...args: unknown[]) => MockLocator>()
      .mockReturnValue(locator),
    getByTitle: vi.fn<(...args: unknown[]) => MockLocator>().mockReturnValue(locator),
    getByAltText: vi
      .fn<(...args: unknown[]) => MockLocator>()
      .mockReturnValue(locator),
    textContent: vi
      .fn<(...args: unknown[]) => Promise<string | null>>()
      .mockResolvedValue("Fallback page text"),
    screenshot: vi
      .fn<AsyncUnknownFunction<Buffer>>()
      .mockResolvedValue(Buffer.from("fake-png")),
    evaluate: vi.fn<AsyncUnknownFunction<string[]>>().mockResolvedValue([
      "h1 | text=Example Domain",
      "button | role=button | text=Continue",
    ]),
    waitForLoadState: vi
      .fn<AsyncUnknownFunction<void>>()
      .mockResolvedValue(undefined),
    waitForURL: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
    waitForTimeout: vi
      .fn<AsyncUnknownFunction<void>>()
      .mockResolvedValue(undefined),
  };
  const context: MockContext = {
    newPage: vi.fn<AsyncUnknownFunction<MockPage>>().mockResolvedValue(page),
    close: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
  };
  const browser: MockBrowser = {
    newContext: vi
      .fn<AsyncUnknownFunction<MockContext>>()
      .mockResolvedValue(context),
    close: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
  };

  return {
    locator,
    page,
    context,
    browser,
  };
};

const getBrowserTool = (name: string) => {
  const tool = createBrowserToolDefinitions().find(
    (definition) => definition.spec.name === name,
  );

  if (!tool) {
    throw new Error(`Missing browser tool ${name}`);
  }

  return tool;
};

afterEach(async () => {
  await closeAllBrowserSessionsForTests();
  chromiumLaunchMock.mockReset();
});

describe("createBrowserToolDefinitions", () => {
  it("registers browser session, inspection, action, and cleanup tools", () => {
    expect(
      createBrowserToolDefinitions().map((definition) => ({
        name: definition.spec.name,
        riskLevel: definition.riskLevel,
        backingTool: definition.backingTool,
        effect: definition.effect,
      })),
    ).toEqual([
      {
        name: "start_browser_session",
        riskLevel: "high",
        backingTool: "browser",
        effect: "external-side-effect",
      },
      {
        name: "navigate_browser_page",
        riskLevel: "medium",
        backingTool: "browser",
        effect: "external-side-effect",
      },
      {
        name: "read_browser_page",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "capture_browser_page",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "snapshot_browser_page",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "compare_browser_screenshot",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "inspect_browser_locator",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "wait_for_browser_page",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "click_browser_selector",
        riskLevel: "high",
        backingTool: "browser",
        effect: "external-side-effect",
      },
      {
        name: "type_browser_text",
        riskLevel: "high",
        backingTool: "browser",
        effect: "external-side-effect",
      },
      {
        name: "list_browser_sessions",
        riskLevel: "low",
        backingTool: "browser",
        effect: "read",
      },
      {
        name: "close_browser_session",
        riskLevel: "low",
        backingTool: "browser",
        effect: "external-side-effect",
      },
    ]);
  });

  it("starts an installed-channel browser session and navigates to an HTTP URL", async () => {
    const { browser, page } = createMockBrowserStack();

    chromiumLaunchMock.mockResolvedValue(browser);

    const result = await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "docs",
        channel: "msedge",
        url: "https://example.com",
        headless: true,
        viewportWidth: 1440,
        viewportHeight: 900,
      },
      createExecutionContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("session: docs");
    expect(chromiumLaunchMock).toHaveBeenCalledWith({
      channel: "msedge",
      headless: true,
    });
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: {
        width: 1440,
        height: 900,
      },
    });
    expect(page.goto).toHaveBeenCalledWith("https://example.com/", {
      waitUntil: "load",
      timeout: 30_000,
    });
  });

  it("closes a newly launched browser when initial navigation fails", async () => {
    const { browser, context, page } = createMockBrowserStack();

    page.goto.mockRejectedValue(new Error("navigation timed out"));
    chromiumLaunchMock.mockResolvedValue(browser);

    const result = await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "failed-nav",
        channel: "msedge",
        url: "https://example.com",
      },
      createExecutionContext(),
    );
    const listResult = await getBrowserTool("list_browser_sessions").execute(
      {},
      createExecutionContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("navigation timed out");
    expect(context.close).toHaveBeenCalledWith({
      reason: "Browser session closed by machdoch.",
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(listResult.toolResult.output).toBe("No browser sessions are open.");
  });

  it("closes a browser if context creation fails during launch", async () => {
    const browser: MockBrowser = {
      newContext: vi
        .fn<AsyncUnknownFunction<MockContext>>()
        .mockRejectedValue(new Error("context failed")),
      close: vi.fn<AsyncUnknownFunction<void>>().mockResolvedValue(undefined),
    };

    chromiumLaunchMock.mockResolvedValue(browser);

    const result = await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "failed-context",
        channel: "msedge",
      },
      createExecutionContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("context failed");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("rejects local file navigation before launching a browser", async () => {
    const result = await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "local",
        channel: "msedge",
        url: "file:///c:/secret.txt",
      },
      createExecutionContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain(
      "only supports HTTP, HTTPS, and about:blank",
    );
    expect(chromiumLaunchMock).not.toHaveBeenCalled();
  });

  it("reads text, captures screenshots, clicks selectors, and fills text", async () => {
    const { browser, locator } = createMockBrowserStack();

    chromiumLaunchMock.mockResolvedValue(browser);

    await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "flow",
        channel: "chrome",
      },
      createExecutionContext(),
    );

    const readResult = await getBrowserTool("read_browser_page").execute(
      { sessionId: "flow" },
      createExecutionContext(),
    );
    const screenshotResult = await getBrowserTool(
      "capture_browser_page",
    ).execute({ sessionId: "flow", fullPage: true }, createExecutionContext());
    const clickResult = await getBrowserTool("click_browser_selector").execute(
      { sessionId: "flow", selector: "text=Continue" },
      createExecutionContext(),
    );
    const typeResult = await getBrowserTool("type_browser_text").execute(
      {
        sessionId: "flow",
        selector: "input[name=q]",
        text: "machdoch",
      },
      createExecutionContext(),
    );

    expect(readResult.toolResult.output).toContain("Visible page text");
    expect(screenshotResult.toolResult.content?.[1]).toMatchObject({
      type: "image",
      mediaType: "image/png",
      data: Buffer.from("fake-png").toString("base64"),
    });
    expect(clickResult.toolResult.isError).toBeUndefined();
    expect(typeResult.toolResult.isError).toBeUndefined();
    expect(locator.click).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(locator.fill).toHaveBeenCalledWith("machdoch", {
      timeout: 30_000,
    });
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 30_000,
    });
  });

  it("supports semantic locators, snapshots, explicit waits, and screenshot comparison", async () => {
    const { browser, page, locator } = createMockBrowserStack();

    chromiumLaunchMock.mockResolvedValue(browser);

    await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "quality",
        channel: "chrome",
      },
      createExecutionContext(),
    );

    const inspectResult = await getBrowserTool("inspect_browser_locator").execute(
      {
        sessionId: "quality",
        locatorType: "role",
        locatorValue: "button",
        locatorName: "Continue",
        exact: true,
      },
      createExecutionContext(),
    );
    const snapshotResult = await getBrowserTool("snapshot_browser_page").execute(
      { sessionId: "quality" },
      createExecutionContext(),
    );

    await getBrowserTool("wait_for_browser_page").execute(
      {
        sessionId: "quality",
        waitFor: "locator-visible",
        locatorType: "testId",
        locatorValue: "submit",
      },
      createExecutionContext(),
    );

    await getBrowserTool("capture_browser_page").execute(
      {
        sessionId: "quality",
        baselineId: "before-submit",
      },
      createExecutionContext(),
    );
    const compareResult = await getBrowserTool(
      "compare_browser_screenshot",
    ).execute(
      {
        sessionId: "quality",
        baselineId: "before-submit",
      },
      createExecutionContext(),
    );

    expect(page.getByRole).toHaveBeenCalledWith("button", {
      name: "Continue",
      exact: true,
    });
    expect(page.getByTestId).toHaveBeenCalledWith("submit");
    expect(inspectResult.toolResult.output).toContain("visible: yes");
    expect(snapshotResult.toolResult.output).toContain("Example Domain");
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 30_000,
    });
    expect(compareResult.toolResult.output).toContain("changed: no");
  });

  it("lists and closes browser sessions", async () => {
    const { browser, context } = createMockBrowserStack();

    chromiumLaunchMock.mockResolvedValue(browser);

    await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "cleanup",
        channel: "chrome",
      },
      createExecutionContext(),
    );

    const listResult = await getBrowserTool("list_browser_sessions").execute(
      {},
      createExecutionContext(),
    );
    const closeResult = await getBrowserTool("close_browser_session").execute(
      { sessionId: "cleanup" },
      createExecutionContext(),
    );

    expect(listResult.toolResult.output).toContain("cleanup");
    expect(closeResult.toolResult.output).toContain(
      "Closed browser session cleanup",
    );
    expect(context.close).toHaveBeenCalledWith({
      reason: "Browser session closed by machdoch.",
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("still closes the browser process when browser context cleanup fails", async () => {
    const { browser, context } = createMockBrowserStack();

    context.close.mockRejectedValue(new Error("context close failed"));
    chromiumLaunchMock.mockResolvedValue(browser);

    await getBrowserTool("start_browser_session").execute(
      {
        sessionId: "cleanup-failure",
        channel: "chrome",
      },
      createExecutionContext(),
    );

    const closeResult = await getBrowserTool("close_browser_session").execute(
      { sessionId: "cleanup-failure" },
      createExecutionContext(),
    );
    const listResult = await getBrowserTool("list_browser_sessions").execute(
      {},
      createExecutionContext(),
    );

    expect(closeResult.toolResult.isError).toBe(true);
    expect(closeResult.toolResult.output).toContain("context close failed");
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(listResult.toolResult.output).toBe("No browser sessions are open.");
  });
});
