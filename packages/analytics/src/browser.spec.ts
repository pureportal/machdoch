import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exposeFeature,
  getConsentSnapshot,
  observeJob,
  setAnalyticsConsent,
  startBrowserAnalytics,
  trackRoute,
  useFeature,
} from "./browser.js";
import { trackOperation } from "./operations.js";
import { PROJECTS } from "./catalog.js";
import { consentKey, writeConsent } from "./consent.js";

let cleanup: (() => void) | undefined;
const fetch = vi.fn<typeof globalThis.fetch>();
const payloads = (): Record<string, unknown>[] =>
  fetch.mock.calls.map((call) => JSON.parse(call[1]?.body as string));
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  fetch.mockReset().mockResolvedValue(new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("performance", {
    now: () => Date.now(),
    getEntriesByType: () => [],
  });
  vi.stubGlobal("navigator", {
    language: "en-US",
    doNotTrack: "0",
    globalPrivacyControl: false,
  });
  document.body.innerHTML =
    '<button data-analytics-feature="chat">Chat</button>';
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser consent lifecycle", () => {
  it.each(["landing", "fleet", "software"] as const)(
    "keeps %s silent before consent",
    async (app) => {
      cleanup = startBrowserAnalytics({
        app,
        version: "30.1.0",
        development: false,
      });
      useFeature("chat");
      exposeFeature("ralph");
      await trackOperation("run_desktop_task", async () => "result");
      expect(fetch).not.toHaveBeenCalled();
      setAnalyticsConsent(true);
      await settle();
      expect(payloads().every((payload) => payload.pid === PROJECTS[app])).toBe(
        true,
      );
      expect(getConsentSnapshot().enabled).toBe(true);
    },
  );
  it("honors Do Not Track even when consent was previously saved", () => {
    writeConsent(localStorage, "fleet", true);
    vi.stubGlobal("navigator", { language: "en-US", doNotTrack: "1" });
    cleanup = startBrowserAnalytics({
      app: "fleet",
      version: "30.1.0",
      development: false,
    });
    setAnalyticsConsent(true);
    expect(getConsentSnapshot()).toMatchObject({
      enabled: false,
      blocked: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors Global Privacy Control", () => {
    vi.stubGlobal("navigator", {
      language: "en-US",
      globalPrivacyControl: true,
    });
    cleanup = startBrowserAnalytics({
      app: "software",
      version: "30.1.0",
      development: false,
    });
    setAnalyticsConsent(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not send developer traffic", () => {
    writeConsent(localStorage, "fleet", true);
    cleanup = startBrowserAnalytics({
      app: "fleet",
      version: "30.1.0",
      development: true,
    });
    useFeature("chat");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("withdraws immediately and ignores late completions even after consent is renewed", async () => {
    cleanup = startBrowserAnalytics({
      app: "software",
      version: "30.1.0",
      development: false,
    });
    setAnalyticsConsent(true);
    await settle();
    let resolve: ((value: string) => void) | undefined;
    const operation = trackOperation(
      "run_desktop_task",
      () =>
        new Promise<string>((complete) => {
          resolve = complete;
        }),
    );
    setAnalyticsConsent(false);
    const count = fetch.mock.calls.length;
    useFeature("chat");
    window.dispatchEvent(new Event("pagehide"));
    expect(fetch.mock.calls.length).toBe(count);
    setAnalyticsConsent(true);
    await settle();
    const renewedCount = fetch.mock.calls.length;
    resolve!("result");
    await operation;
    expect(fetch.mock.calls.length).toBe(renewedCount);
  });
  it("responds to withdrawal in another tab", async () => {
    writeConsent(localStorage, "fleet", true);
    cleanup = startBrowserAnalytics({
      app: "fleet",
      version: "30.1.0",
      development: false,
    });
    await settle();
    writeConsent(localStorage, "fleet", false);
    window.dispatchEvent(
      new StorageEvent("storage", { key: consentKey("fleet") }),
    );
    const count = fetch.mock.calls.length;
    useFeature("chat");
    expect(fetch.mock.calls.length).toBe(count);
    expect(getConsentSnapshot().enabled).toBe(false);
  });
  it("waits for completed navigation before starting remembered consent", async () => {
    const ready = vi
      .spyOn(document, "readyState", "get")
      .mockReturnValue("loading");
    writeConsent(localStorage, "landing", true);
    cleanup = startBrowserAnalytics({
      app: "landing",
      version: "30.1.0",
      development: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    ready.mockReturnValue("complete");
    window.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
    expect(payloads().some((payload) => payload.ev === "session.started")).toBe(
      true,
    );
    ready.mockRestore();
  });
  it("fails closed when preferences cannot be stored", () => {
    cleanup = startBrowserAnalytics({
      app: "fleet",
      version: "30.1.0",
      development: false,
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    setAnalyticsConsent(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(getConsentSnapshot()).toMatchObject({
      enabled: false,
      error: expect.any(String),
    });
  });
  it("allocates performance observers only after consent and disconnects them on withdrawal", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes = [
          "paint",
          "largest-contentful-paint",
          "layout-shift",
          "event",
        ];
        observe = observe;
        disconnect = disconnect;
      },
    );
    cleanup = startBrowserAnalytics({
      app: "software",
      version: "30.1.0",
      development: false,
    });
    expect(observe).not.toHaveBeenCalled();
    setAnalyticsConsent(true);
    expect(observe).toHaveBeenCalledTimes(4);
    setAnalyticsConsent(false);
    expect(disconnect).toHaveBeenCalledTimes(4);
  });
  it("records unused exposed features separately from used features", async () => {
    cleanup = startBrowserAnalytics({
      app: "software",
      version: "30.1.0",
      development: false,
    });
    setAnalyticsConsent(true);
    await settle();
    exposeFeature("ralph");
    exposeFeature("chat");
    useFeature("chat");
    await settle();
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    const summaries = payloads().filter(
      (payload) => payload.ev === "feature.summary",
    );
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          meta: expect.objectContaining({ feature: "ralph", used: false }),
        }),
        expect.objectContaining({
          meta: expect.objectContaining({ feature: "chat", used: true }),
        }),
      ]),
    );
  });
  it("tracks final job outcomes once without transmitting job identifiers", async () => {
    cleanup = startBrowserAnalytics({
      app: "software",
      version: "30.1.0",
      development: false,
    });
    setAnalyticsConsent(true);
    await settle();
    observeJob("private-job-id", "media.generate", "queued");
    observeJob("private-job-id", "media.generate", "running");
    observeJob("private-job-id", "media.generate", "completed");
    observeJob("private-job-id", "media.generate", "completed");
    await settle();
    expect(
      payloads().filter((payload) => payload.ev === "job.completed"),
    ).toHaveLength(1);
    expect(JSON.stringify(payloads())).not.toContain("private-job-id");
  });
  it("removes device IDs, query parameters, and fragments from route tracking", async () => {
    cleanup = startBrowserAnalytics({
      app: "fleet",
      version: "30.1.0",
      development: false,
    });
    setAnalyticsConsent(true);
    await settle();
    trackRoute("/instances/private-device-id/runs");
    await settle();
    expect(payloads().at(-1)?.pg).toBe("/instances/:instance/runs");
    expect(JSON.stringify(payloads())).not.toContain("private-device-id");
  });
});
