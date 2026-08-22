import { describe, expect, it } from "vitest";
import { normalizeRemoteControlStatus } from "./normalize-remote-control-status.helper.ts";

const createSession = () => ({
  taskId: "task-1",
  task: "Review changes",
  mode: "machdoch",
  state: "running",
  message: "Working",
  cancellable: true,
  startedAt: 10,
  updatedAt: 20,
  progressCount: 2,
  logs: [
    {
      createdAt: 11,
      stream: "stdout",
      toolName: "shell",
      chunk: "ok",
    },
  ],
  timeline: [
    {
      createdAt: 12,
      kind: "tool",
      phase: "completed",
      label: "Shell",
      detail: "Done",
      tone: "success",
      toolName: "shell",
    },
  ],
});

describe("normalizeRemoteControlStatus", () => {
  it("keeps valid required, optional, session, log, and timeline fields", () => {
    const status = normalizeRemoteControlStatus({
      enabled: true,
      localUrl: "http://127.0.0.1:4567",
      lanUrl: "http://192.168.1.2:4567",
      displayUrl: "",
      qrSvg: "   ",
      tokenHint: "abc...",
      startedAt: 0,
      bindAddress: "127.0.0.1",
      port: 0,
      pairedDeviceCount: 0,
      eventId: 1,
      sessions: [createSession()],
    });

    expect(status).toEqual({
      enabled: true,
      localUrl: "http://127.0.0.1:4567",
      lanUrl: "http://192.168.1.2:4567",
      displayUrl: "",
      qrSvg: "   ",
      tokenHint: "abc...",
      startedAt: 0,
      bindAddress: "127.0.0.1",
      port: 0,
      pairedDeviceCount: 0,
      eventId: 1,
      sessions: [createSession()],
    });
  });

  it("omits null and undefined optional handoff fields", () => {
    expect(
      normalizeRemoteControlStatus({
        enabled: false,
        localUrl: null,
        lanUrl: undefined,
        displayUrl: null,
        qrSvg: null,
        tokenHint: null,
        startedAt: null,
        bindAddress: null,
        port: null,
        pairedDeviceCount: null,
        eventId: 2,
        sessions: [],
      }),
    ).toEqual({
      enabled: false,
      eventId: 2,
      sessions: [],
    });
  });

  it.each([
    ["null payload", null],
    ["undefined payload", undefined],
    ["array payload", []],
    ["missing enabled", { eventId: 1, sessions: [] }],
    ["non-boolean enabled", { enabled: "true", eventId: 1, sessions: [] }],
    ["missing event id", { enabled: true, sessions: [] }],
    ["non-finite event id", { enabled: true, eventId: Number.NaN, sessions: [] }],
    ["missing sessions", { enabled: true, eventId: 1 }],
    ["non-array sessions", { enabled: true, eventId: 1, sessions: {} }],
  ])("rejects invalid status payloads: %s", (_label, payload) => {
    expect(normalizeRemoteControlStatus(payload)).toBeNull();
  });

  it.each([
    ["localUrl", 4567],
    ["lanUrl", true],
    ["displayUrl", {}],
    ["qrSvg", []],
    ["tokenHint", 1],
    ["startedAt", Number.POSITIVE_INFINITY],
    ["bindAddress", false],
    ["port", "4567"],
    ["pairedDeviceCount", Number.NaN],
  ])("rejects invalid optional field type for %s", (field, value) => {
    expect(
      normalizeRemoteControlStatus({
        enabled: true,
        eventId: 1,
        sessions: [],
        [field]: value,
      }),
    ).toBeNull();
  });

  it.each([
    ["log createdAt must be finite", { logs: [{ createdAt: Infinity }] }],
    ["log stream must be a string", { logs: [{ stream: 1 }] }],
    ["timeline createdAt must be finite", { timeline: [{ createdAt: NaN }] }],
    ["timeline label must be a string", { timeline: [{ label: 1 }] }],
    ["session progressCount must be finite", { progressCount: Infinity }],
  ])("rejects invalid nested session data: %s", (_label, override) => {
    const session = createSession();
    const payload = { ...session, ...override };

    expect(
      normalizeRemoteControlStatus({
        enabled: true,
        eventId: 1,
        sessions: [payload],
      }),
    ).toBeNull();
  });
});
