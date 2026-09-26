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
import { MediaPoseWorkspace } from "./media-pose-workspace";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
  localStorage.clear();
});

describe("saved Pose chats", () => {
  it("reads the persisted scene before showing it in the Pose map", async () => {
    const map = {
      aspectRatio: "4:5" as const,
      people: [0.25, 0.5, 0.75].map((x) => ({
        pose: "climbing" as const,
        x,
        y: 0.9,
        scale: 0.5,
        mirror: false,
      })),
    };
    invoke.mockResolvedValue(map);
    const onGenerate = vi.fn();
    const onLoadScene = vi.fn();
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        savedScenes: [
          {
            id: "f80df106-e48d-4b5f-9585-0eb51742f988",
            label: "3 persons climbing a rock",
          },
        ],
        onLoadScene,
        onGenerate,
        onApply: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    const scene = await screen.findByRole("button", {
      name: "Edit 3 persons climbing a rock",
    });
    expect(invoke).toHaveBeenCalledWith("media_read_pose_scene", {
      sessionId: "f80df106-e48d-4b5f-9585-0eb51742f988",
    });
    fireEvent.click(scene);
    expect(onLoadScene).toHaveBeenCalledWith(map);
    expect(
      screen.getAllByRole("button", { name: /^Pose [1-3]$/ }),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Open in Pose chat" }));
    await waitFor(() =>
      expect(onGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          aspectRatio: "4:5",
          people: expect.arrayContaining([
            expect.objectContaining({ pose: "climbing" }),
          ]),
        }),
      ),
    );
  });
});
