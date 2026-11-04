import { describe, expect, it, vi } from "vitest";
import {
  listPreviewWorkspaceDirectory,
  readPreviewWorkspaceFile,
  resolvePreviewWorkspaceFileSource,
  startPreviewWorkspaceTerminal,
  stopPreviewWorkspaceTerminal,
  stopPreviewWorkspaceTerminals,
  writePreviewWorkspaceTerminal,
} from "./workspace-preview-runtime";

describe("workspace browser preview runtime", () => {
  it("exposes representative file and media states", () => {
    const assets = listPreviewWorkspaceDirectory("assets", 0);
    expect(assets.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["sample.bin", "tone.wav", "clip.webm"]),
    );
    expect(readPreviewWorkspaceFile("assets/sample.bin").kind).toBe("binary");
    expect(readPreviewWorkspaceFile("docs/build-output.log").kind).toBe(
      "oversized",
    );
    expect(readPreviewWorkspaceFile("docs/sample.pdf").previewKind).toBe("pdf");
    expect(resolvePreviewWorkspaceFileSource("assets/tone.wav")).toMatch(
      /^data:audio\/wav;base64,/u,
    );
  });

  it("keeps terminal sessions isolated when a workspace is removed", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout });
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const first = startPreviewWorkspaceTerminal(
      "C:\\Projects\\first",
      "pwsh",
      (event) => firstEvents.push(event.type),
    );
    const second = startPreviewWorkspaceTerminal(
      "C:\\Projects\\second",
      "cmd",
      (event) => secondEvents.push(event.type),
    );

    vi.runAllTimers();
    expect(first.shellId).toBe("pwsh");
    expect(second.shellId).toBe("cmd");
    expect(stopPreviewWorkspaceTerminals("C:\\Projects\\first")).toBe(1);
    expect(firstEvents).toContain("exit");
    expect(() =>
      writePreviewWorkspaceTerminal(first.sessionId, "echo stopped\r"),
    ).toThrow("no longer running");
    expect(() =>
      writePreviewWorkspaceTerminal(second.sessionId, "echo alive\r"),
    ).not.toThrow();
    expect(secondEvents).not.toContain("exit");

    stopPreviewWorkspaceTerminal(second.sessionId);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
