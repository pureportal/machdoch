import {
  mcpAppProtocolVersion,
  type McpAppView,
} from "@machdoch/fleet-protocol/mcp-apps";
import { describe, expect, it, vi } from "vitest";
import { connectMcpApp, type McpAppInvoke } from "./host";
import { appContentPolicy, sandboxedAppHtml, sandboxProxyUrl } from "./sandbox";

function makeView(): McpAppView {
  return {
    id: "8091cdeb-6750-4aa5-a409-d70bea972e29",
    title: "Research results",
    html: "<main>Results</main>",
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    arguments: { query: "workspace knowledge" },
    result: { content: [{ type: "text", text: "Found three documents" }] },
  };
}

it("permits declared secure WebSocket connections without granting script or frame access", () => {
  const view = makeView();
  view.csp.connectDomains = ["wss://stream.example.com"];
  expect(appContentPolicy(view.csp)).toContain(
    "connect-src wss://stream.example.com;",
  );
  expect(() =>
    appContentPolicy({
      ...view.csp,
      resourceDomains: ["wss://stream.example.com"],
    }),
  ).toThrow();
  expect(() =>
    appContentPolicy({
      ...view.csp,
      connectDomains: ["ws://stream.example.com"],
    }),
  ).toThrow();
  expect(() =>
    appContentPolicy({
      ...view.csp,
      connectDomains: ["wss://token@stream.example.com"],
    }),
  ).toThrow();
});

function createHost() {
  const view = makeView();
  const workspaceRoot = "C:\\workspaces\\research";
  const invoke = vi.fn<McpAppInvoke>().mockResolvedValue(view.result);
  const send = vi.fn<Parameters<typeof connectMcpApp>[0]["send"]>();
  const confirmTool = vi
    .fn<Parameters<typeof connectMcpApp>[0]["confirmTool"]>()
    .mockResolvedValue(true);
  const onHeight = vi.fn<(height: number) => void>();
  const onInitialized = vi.fn<() => void>();
  const host = connectMcpApp({
    view,
    workspaceRoot,
    invoke: invoke as McpAppInvoke,
    send,
    confirmTool,
    onHeight,
    onInitialized,
  });
  return {
    host,
    view,
    workspaceRoot,
    invoke,
    send,
    confirmTool,
    onHeight,
    onInitialized,
  };
}

function negotiate(
  host: ReturnType<typeof connectMcpApp>,
  protocolVersion = mcpAppProtocolVersion,
) {
  return host.receive({
    jsonrpc: "2.0",
    id: "initialize",
    method: "ui/initialize",
    params: { protocolVersion },
  });
}

async function initialize(host: ReturnType<typeof connectMcpApp>) {
  await negotiate(host);
  await host.receive({
    jsonrpc: "2.0",
    method: "ui/notifications/initialized",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("connectMcpApp", () => {
  it("reports readiness once, after negotiation and delivery of the original result", async () => {
    const { host, send, onInitialized } = createHost();
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    await negotiate(host);
    expect(onInitialized).not.toHaveBeenCalled();
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "ui/notifications/tool-result" }),
    );
    expect(onInitialized).toHaveBeenCalledOnce();
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    expect(onInitialized).toHaveBeenCalledOnce();
  });
  it("accepts tools with no arguments after confirmation", async () => {
    const { host, invoke, confirmTool, view, workspaceRoot } = createHost();
    await initialize(host);
    await host.receive({
      jsonrpc: "2.0",
      id: "refresh",
      method: "tools/call",
      params: { name: "refresh" },
    });
    expect(confirmTool).toHaveBeenCalledWith("refresh", {});
    expect(invoke).toHaveBeenCalledWith(workspaceRoot, {
      action: "call-tool",
      id: view.id,
      name: "refresh",
      arguments: {},
      confirmed: true,
    });
  });
  it("requires negotiation and the initialized notification before tools can run", async () => {
    const { host, send, confirmTool, invoke } = createHost();
    const call = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    };

    await host.receive({ ...call, id: "before-negotiation" });
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    await host.receive({ ...call, id: "premature-notification" });
    await negotiate(host);
    await host.receive({ ...call, id: "before-initialized" });

    for (const id of [
      "before-negotiation",
      "premature-notification",
      "before-initialized",
    ]) {
      expect(send).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Initialize the app before making requests.",
        },
      });
    }
    expect(confirmTool).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    await host.receive({ ...call, id: "ready" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("delivers the original arguments and result once, after initialization", async () => {
    const { host, view, send } = createHost();

    await negotiate(host);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: "initialize",
      result: expect.objectContaining({
        protocolVersion: mcpAppProtocolVersion,
        hostCapabilities: {
          serverTools: {},
          sandbox: { csp: view.csp, permissions: {} },
        },
      }),
    });
    send.mockClear();

    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });

    expect(send.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: view.arguments },
        },
      ],
      [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: view.result,
        },
      ],
    ]);
  });

  it("rejects an unsupported protocol without enabling tool calls", async () => {
    const { host, send, confirmTool, invoke } = createHost();

    await negotiate(host, "unsupported");
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    await host.receive({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });

    expect(send).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: "initialize",
      error: {
        code: -32602,
        message: "Unsupported or repeated app initialization.",
      },
    });
    expect(confirmTool).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("provides the proxy with CSP-protected app content", async () => {
    const { host, view, send } = createHost();

    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
    });

    expect(send.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: {
            html: sandboxedAppHtml(view),
            sandbox: "allow-scripts allow-same-origin",
            csp: view.csp,
            permissions: {},
          },
        },
      ],
    ]);
  });

  it.each([7, "call-7"])(
    "scopes approved call %s to its view and workspace and returns the tool result",
    async (id) => {
      const { host, view, workspaceRoot, confirmTool, invoke, send } =
        createHost();
      const args = { query: "notes" };
      const result = {
        content: [{ type: "text", text: "Updated results" }],
        structuredContent: { count: 2 },
      };
      invoke.mockResolvedValueOnce(result);
      await initialize(host);
      send.mockClear();

      await host.receive({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "search",
          arguments: args,
          id: "another-view",
          workspaceRoot: "C:\\other",
          confirmed: true,
        },
      });

      expect(confirmTool).toHaveBeenCalledTimes(1);
      expect(confirmTool).toHaveBeenCalledWith("search", args);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(workspaceRoot, {
        action: "call-tool",
        id: view.id,
        name: "search",
        arguments: args,
        confirmed: true,
      });
      expect(send.mock.calls).toEqual([[{ jsonrpc: "2.0", id, result }]]);
    },
  );

  it("does not invoke a denied action and allows a later confirmed action", async () => {
    const { host, confirmTool, invoke, send } = createHost();
    confirmTool.mockResolvedValueOnce(false);
    await initialize(host);
    send.mockClear();

    await host.receive({
      jsonrpc: "2.0",
      id: "denied",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });

    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(confirmTool).toHaveBeenCalledWith("search", {});
    expect(invoke).not.toHaveBeenCalled();
    expect(send.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          id: "denied",
          error: { code: -32602, message: "The action was cancelled." },
        },
      ],
    ]);

    await host.receive({
      jsonrpc: "2.0",
      id: "approved",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([9, "call-9"])(
    "does not repeat confirmation or invocation for duplicate ID %s",
    async (id) => {
      const { host, confirmTool, invoke, send } = createHost();
      const approval = deferred<boolean>();
      confirmTool.mockReturnValueOnce(approval.promise);
      await initialize(host);
      send.mockClear();
      const message = {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "search", arguments: {} },
      };

      const first = host.receive(message);
      await host.receive(message);
      expect(confirmTool).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();

      approval.resolve(true);
      await first;
      await host.receive(message);

      expect(confirmTool).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["resources/read", "tools/list", "ui/open-link"])(
    "rejects unsupported capability %s",
    async (method) => {
      const { host, send, confirmTool, invoke } = createHost();
      await initialize(host);
      send.mockClear();

      await host.receive({
        jsonrpc: "2.0",
        id: "unsupported",
        method,
        params: {},
      });

      expect(send.mock.calls).toEqual([
        [
          {
            jsonrpc: "2.0",
            id: "unsupported",
            error: {
              code: -32601,
              message: "This app capability is unavailable.",
            },
          },
        ],
      ]);
      expect(confirmTool).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("ignores messages over the size limit without consuming their IDs", async () => {
    const { host, send, confirmTool, invoke } = createHost();
    await initialize(host);
    send.mockClear();
    const message = {
      jsonrpc: "2.0",
      id: "bounded",
      method: "tools/call",
      params: { name: "search", arguments: { padding: "" } },
    };
    message.params.arguments.padding = "x".repeat(
      256_000 - JSON.stringify(message).length,
    );

    await host.receive({
      ...message,
      params: {
        ...message.params,
        arguments: { padding: message.params.arguments.padding + "x" },
      },
    });

    expect(send).not.toHaveBeenCalled();
    expect(confirmTool).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    await host.receive(message);

    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: "bounded",
      result: expect.any(Object),
    });
  });

  it("bounds finite heights and ignores invalid heights", async () => {
    const { host, onHeight } = createHost();
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 400 },
    });
    expect(onHeight).not.toHaveBeenCalled();
    await initialize(host);

    for (const height of [
      -1,
      0,
      180,
      450,
      800,
      5000,
      NaN,
      Infinity,
      -Infinity,
      "400",
      null,
      undefined,
    ]) {
      await host.receive({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height },
      });
    }

    expect(onHeight.mock.calls).toEqual([
      [180],
      [180],
      [180],
      [450],
      [800],
      [800],
    ]);
  });

  it("sends teardown once and ignores further messages", async () => {
    const { host, view, send, confirmTool, invoke, onHeight } = createHost();
    await initialize(host);
    send.mockClear();

    host.close();
    host.close();
    await host.receive({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    await host.receive({ jsonrpc: "2.0", id: "ping", method: "ping" });
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 400 },
    });
    await host.receive({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
    });

    expect(send.mock.calls).toEqual([
      [
        {
          jsonrpc: "2.0",
          id: `teardown-${view.id}`,
          method: "ui/resource-teardown",
          params: {},
        },
      ],
    ]);
    expect(confirmTool).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(onHeight).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "closes before initialization without teardown (negotiated: %s)",
    async (negotiated) => {
      const { host, send } = createHost();
      if (negotiated) await negotiate(host);
      send.mockClear();

      host.close();
      await initialize(host);

      expect(send).not.toHaveBeenCalled();
    },
  );

  it("does not invoke an action approved after the host closes", async () => {
    const { host, confirmTool, invoke, send } = createHost();
    const approval = deferred<boolean>();
    confirmTool.mockReturnValueOnce(approval.promise);
    await initialize(host);
    const pending = host.receive({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    expect(confirmTool).toHaveBeenCalledTimes(1);

    host.close();
    send.mockClear();
    approval.resolve(true);
    await pending;

    expect(invoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not deliver a tool response after the host closes", async () => {
    const { host, invoke, send } = createHost();
    const started = deferred<void>();
    const result = deferred<unknown>();
    invoke.mockImplementationOnce(<T>() => {
      started.resolve(undefined);
      return result.promise as Promise<T>;
    });
    await initialize(host);
    const pending = host.receive({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    await started.promise;

    host.close();
    send.mockClear();
    result.resolve({ content: [] });
    await pending;

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("MCP App sandbox", () => {
  it("denies external access by default", () => {
    const policy = appContentPolicy(makeView().csp);

    expect(policy.split("; ").map((directive) => directive.trim())).toEqual([
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "font-src 'none'",
      "media-src data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'none'",
    ]);
  });

  it("grants approved HTTPS origins only to their specified directives", () => {
    const policy = appContentPolicy({
      connectDomains: ["https://api.example.test"],
      resourceDomains: ["https://cdn.example.test"],
      frameDomains: ["https://frames.example.test"],
      baseUriDomains: ["https://base.example.test"],
    });

    expect(policy.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'unsafe-inline' https://cdn.example.test",
      "style-src 'unsafe-inline' https://cdn.example.test",
      "img-src data: https://cdn.example.test",
      "font-src https://cdn.example.test",
      "media-src data: https://cdn.example.test",
      "connect-src https://api.example.test",
      "frame-src https://frames.example.test",
      "base-uri https://base.example.test",
      "object-src 'none'",
      "form-action 'none'",
    ]);
  });

  describe.each([
    "connectDomains",
    "resourceDomains",
    "frameDomains",
    "baseUriDomains",
  ] as const)("%s", (field) => {
    it.each([
      "http://example.test",
      ...(field === "connectDomains"
        ? ["ws://example.test"]
        : ["wss://example.test"]),
      "data:text/html,unsafe",
      "https://user:password@example.test",
      "https://example.test/path",
      "https://example.test; script-src *",
      'https://example.test"><script>alert(1)</script>',
    ])("rejects unsafe CSP source %s in every sandbox export", (domain) => {
      const view = makeView();
      view.csp[field] = [domain];

      expect(() => appContentPolicy(view.csp)).toThrow();
      expect(() => sandboxedAppHtml(view)).toThrow();
      expect(() => sandboxProxyUrl(view.csp)).toThrow();
    });
  });

  it("places the app policy before provider HTML without weakening it", () => {
    const view = makeView();
    view.html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><main>Results &amp; notes</main></body></html>';
    const html = sandboxedAppHtml(view);
    const appDocument = new DOMParser().parseFromString(html, "text/html");
    const policies = appDocument.querySelectorAll(
      'meta[http-equiv="Content-Security-Policy"]',
    );

    expect(policies).toHaveLength(2);
    expect(policies[0]?.getAttribute("content")).toBe(
      appContentPolicy(view.csp),
    );
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf(view.html),
    );
    expect(html.endsWith(view.html)).toBe(true);
    expect(appDocument.querySelector("main")?.textContent).toBe(
      "Results & notes",
    );
  });

  it("uses an opaque data URL and grants local frame schemes only to the proxy", () => {
    const view = makeView();
    view.csp.frameDomains = ["https://frames.example.test"];
    const url = new URL(sandboxProxyUrl(view.csp));
    const prefix = "data:text/html;charset=utf-8,";
    expect(url.protocol).toBe("data:");
    expect(url.origin).toBe("null");
    expect(url.href.startsWith(prefix)).toBe(true);

    const proxyDocument = new DOMParser().parseFromString(
      decodeURIComponent(url.href.slice(prefix.length)),
      "text/html",
    );
    const proxyPolicy = proxyDocument
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    const appDocument = new DOMParser().parseFromString(
      sandboxedAppHtml(view),
      "text/html",
    );
    const appPolicy = appDocument
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");

    expect(proxyPolicy?.split("; ")).toContain(
      "frame-src about: data: blob: https://frames.example.test",
    );
    expect(appPolicy?.split("; ")).toContain(
      "frame-src https://frames.example.test",
    );
    expect(
      proxyPolicy
        ?.split("; ")
        .filter((directive) => !directive.startsWith("frame-src ")),
    ).toEqual(
      appPolicy
        ?.split("; ")
        .filter((directive) => !directive.startsWith("frame-src ")),
    );
    expect(proxyDocument.querySelector("iframe")).toBeNull();
    expect(proxyDocument.querySelector("main")).toBeNull();
    expect(proxyDocument.querySelectorAll("script")).toHaveLength(1);
  });
});
