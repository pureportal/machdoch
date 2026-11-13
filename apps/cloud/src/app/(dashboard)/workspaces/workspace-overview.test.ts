import { describe, expect, it } from "vitest";
import type { FleetDeviceStatus } from "@/lib/fleet-status";
import {
  displayPath,
  overviewDevices,
  sessionTone,
  sessionWorkspace,
  workspaceName,
  workspaceSessions,
} from "./workspace-overview";

function device(
  displayName: string,
  online: boolean,
  overrides: Partial<FleetDeviceStatus> = {},
): FleetDeviceStatus {
  return {
    instanceId: `instance_${displayName}`,
    displayName,
    online,
    productVersion: "42.1.0",
    versionStatus: "current",
    capturedAt: 1,
    error: null,
    canCreateSession: true,
    workspaceTools: true,
    sessions: [],
    workspaces: [],
    tasks: [],
    failures: [],
    ...overrides,
  };
}

const session = (
  id: string,
  updatedAt: number,
  extra: Partial<FleetDeviceStatus["sessions"][number]> = {},
): FleetDeviceStatus["sessions"][number] => ({
  id,
  title: `Session ${id}`,
  status: "done",
  provider: "claude-cli",
  model: "opus",
  updatedAt,
  ...extra,
});

describe("workspace paths", () => {
  it("hides Windows extended-length prefixes", () => {
    expect(displayPath("\\\\?\\C:\\Development\\machdoch")).toBe(
      "C:\\Development\\machdoch",
    );
    expect(displayPath("\\\\?\\UNC\\server\\share\\repo")).toBe(
      "\\\\server\\share\\repo",
    );
    expect(displayPath("/home/me/repo")).toBe("/home/me/repo");
  });

  it("names a workspace after its last folder", () => {
    expect(
      workspaceName({
        root: "\\\\?\\C:\\Development\\lecka\\",
        label: "lecka",
        sessionCount: 0,
      }),
    ).toBe("lecka");
    expect(workspaceName({ root: "D:\\", label: "D:", sessionCount: 0 })).toBe(
      "D:",
    );
    expect(workspaceName({ root: "/", label: "Root", sessionCount: 0 })).toBe(
      "Root",
    );
  });

  it("matches sessions to workspaces regardless of prefix and case", () => {
    const workspaces = [
      { root: "\\\\?\\C:\\Development\\machdoch", label: "m", sessionCount: 1 },
      { root: "C:\\Development", label: "d", sessionCount: 0 },
    ];
    const chat = session("a", 1, { workspace: "c:\\development\\MACHDOCH" });
    expect(sessionWorkspace(chat, workspaces)).toBe(workspaces[0]);
    expect(sessionWorkspace(session("b", 1), workspaces)).toBeUndefined();
    expect(workspaceSessions(workspaces[0]!, [chat])).toEqual([chat]);
    expect(workspaceSessions(workspaces[1]!, [chat])).toEqual([]);
  });
});

describe("session tones", () => {
  it("maps client session states to display tones", () => {
    expect(sessionTone("running")).toBe("running");
    expect(sessionTone("done")).toBe("success");
    expect(sessionTone("ready")).toBe("success");
    expect(sessionTone("timed-out")).toBe("failed");
    expect(sessionTone("blocked")).toBe("blocked");
    expect(sessionTone("empty")).toBe("idle");
  });
});

describe("workspace overview", () => {
  const studio = device("Studio", true, {
    workspaces: [
      { root: "C:\\Work\\zeta", label: "zeta", sessionCount: 1 },
      { root: "C:\\Work\\alpha", label: "alpha", sessionCount: 1 },
    ],
    sessions: [
      session("old", 10, { workspace: "C:\\Work\\alpha" }),
      session("new", 30, { workspace: "C:\\Work\\zeta", status: "running" }),
      session("chat", 20, { title: "Release notes", model: "sonnet" }),
    ],
  });
  const laptop = device("Laptop", false);

  it("lists online devices first with sorted workspaces and recent sessions", () => {
    const [first, second] = overviewDevices([laptop, studio], "");
    expect(first?.device).toBe(studio);
    expect(second?.device).toBe(laptop);
    expect(first?.workspaces.map(workspaceName)).toEqual(["alpha", "zeta"]);
    expect(first?.sessions.map((entry) => entry.id)).toEqual([
      "new",
      "chat",
      "old",
    ]);
    expect(first?.runningSessions).toBe(1);
  });

  it("keeps everything when the device name matches", () => {
    const [match] = overviewDevices([studio, laptop], "stud");
    expect(match?.workspaces).toHaveLength(2);
    expect(match?.sessions).toHaveLength(3);
  });

  it("narrows to matching workspaces and their sessions", () => {
    const result = overviewDevices([studio, laptop], "alpha");
    expect(result).toHaveLength(1);
    expect(result[0]?.workspaces.map(workspaceName)).toEqual(["alpha"]);
    expect(result[0]?.sessions.map((entry) => entry.id)).toEqual(["old"]);
  });

  it("finds sessions by title or model without their workspace", () => {
    const [match] = overviewDevices([studio], "SONNET");
    expect(match?.workspaces).toEqual([]);
    expect(match?.sessions.map((entry) => entry.id)).toEqual(["chat"]);
    expect(overviewDevices([studio, laptop], "nothing")).toEqual([]);
  });
});
