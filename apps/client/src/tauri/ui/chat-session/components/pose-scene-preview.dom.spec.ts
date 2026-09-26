// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaPoseMap } from "@machdoch/media-studio/core/media/contracts.js";
import { PoseScenePreview } from "./pose-scene-preview";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("Pose chat preview", () => {
  it("shows a generated two-character scene in the current chat", async () => {
    const scene = {
      aspectRatio: "16:9" as const,
      people: [
        {
          pose: "walking" as const,
          x: 0.3,
          y: 0.92,
          scale: 0.75,
          mirror: false,
        },
        { pose: "waving" as const, x: 0.7, y: 0.92, scale: 0.75, mirror: true },
      ],
    };
    invoke.mockResolvedValue(scene);
    const onSceneChange = vi.fn();
    render(
      createElement(PoseScenePreview, {
        sessionId: "6b48f2b2-9b96-4567-aab3-e6423dbe482a",
        onSceneChange,
      }),
    );

    const canvas = await screen.findByRole("img", {
      name: "Editable pose scene",
    });
    expect(invoke).toHaveBeenCalledWith("media_read_pose_scene", {
      sessionId: "6b48f2b2-9b96-4567-aab3-e6423dbe482a",
    });
    expect(canvas.querySelectorAll("line")).toHaveLength(34);
    expect(screen.getByRole("button", { name: "Figure 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Figure 2" })).toBeTruthy();
    await waitFor(() => expect(onSceneChange).toHaveBeenCalledWith(scene));
  });

  it("saves a dragged joint back to the editable chat scene", async () => {
    const sessionId = "6b48f2b2-9b96-4567-aab3-e6423dbe482a";
    let stored: MediaPoseMap = {
      aspectRatio: "1:1" as const,
      people: [
        {
          pose: "standing" as const,
          x: 0.5,
          y: 0.92,
          scale: 0.8,
          mirror: false,
        },
      ],
    };
    invoke.mockImplementation(
      async (command: string, args: { map?: MediaPoseMap }) => {
        if (command === "media_write_pose_scene") {
          stored = args.map!;
          return null;
        }
        return {
          people: stored.people.map(
            ({ pose, x, y, scale, mirror, joints }) => ({
              mirror,
              scale,
              y,
              x,
              pose,
              joints,
            }),
          ),
          aspectRatio: stored.aspectRatio,
        };
      },
    );
    render(createElement(PoseScenePreview, { sessionId }));
    const canvas = await screen.findByRole("img", {
      name: "Editable pose scene",
    });
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    Object.defineProperty(canvas, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(canvas, "hasPointerCapture", { value: () => false });
    fireEvent.doubleClick(screen.getByRole("button", { name: "Figure 1" }));
    const wrist = canvas.querySelectorAll("circle")[4]!;
    fireEvent.pointerDown(wrist, { clientX: 434, clientY: 592, pointerId: 1 });
    fireEvent(
      canvas,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 490,
        clientY: 520,
      }),
    );
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "media_write_pose_scene",
        expect.objectContaining({
          sessionId,
          map: expect.objectContaining({
            people: [expect.objectContaining({ joints: expect.any(Array) })],
          }),
        }),
      ),
    );
    expect(
      (stored.people[0] as { joints?: { x: number; y: number }[] }).joints?.[4]
        ?.x,
    ).toBeGreaterThan(0.37);
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(
          ([command]) => command === "media_read_pose_scene",
        ).length,
      ).toBeGreaterThan(1),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
