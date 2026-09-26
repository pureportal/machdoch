// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaPoseJoints } from "../../../../core/media/pose-map.js";
import { MediaPoseWorkspace } from "./media-pose-workspace";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("MediaPoseWorkspace", () => {
  it("opens a saved three-person chat scene as editable figures", async () => {
    const onGenerate = vi.fn();
    const onLoadScene = vi.fn();
    const people = [0.24, 0.5, 0.76].map((x, index) => ({
      pose: "climbing" as const,
      x,
      y: 0.92 - index * 0.16,
      scale: 0.5,
      mirror: index === 1,
      joints: mediaPoseJoints("climbing"),
    }));
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        savedScenes: [
          {
            id: "scene-1",
            label: "3 persons climbing a rock",
            map: { aspectRatio: "4:5", people },
          },
        ],
        onLoadScene,
        onGenerate,
        onApply: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search poses" }), {
      target: { value: "climbing" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit 3 persons climbing a rock",
      }),
    );
    expect(onLoadScene).toHaveBeenCalledWith({ aspectRatio: "4:5", people });
    expect(
      screen.getAllByRole("button", { name: /^Pose [1-3]$/ }),
    ).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Pose chat" }));
    await waitFor(() =>
      expect(onGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          people: expect.arrayContaining([
            expect.objectContaining({
              pose: "climbing",
              joints: expect.any(Array),
            }),
          ]),
        }),
      ),
    );
  });
  it("adds distinct presets to the canvas and sends a composed map", async () => {
    const onGenerate = vi.fn();
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "4:5",
        onGenerate,
        onApply: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    expect(
      screen.queryByRole("button", { name: "Standing + sitting" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Add pose|Combine$/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Standing" }));
    const firstFigure = screen.getByRole("button", { name: "Pose 1" });
    const firstFigurePosition = firstFigure
      .querySelector("line")
      ?.getAttribute("x1");
    fireEvent.click(screen.getByRole("button", { name: "Add Sitting" }));
    expect(firstFigure.querySelector("line")?.getAttribute("x1")).toBe(
      firstFigurePosition,
    );
    expect(screen.getByRole("button", { name: "Pose 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pose 2" })).toBeTruthy();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Pose 1" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pose 2" }));
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Pose chat" }));
    await waitFor(() =>
      expect(onGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          aspectRatio: "4:5",
          people: [
            expect.objectContaining({ pose: "standing" }),
            expect.objectContaining({ pose: "sitting" }),
          ],
        }),
      ),
    );
  });

  it("moves a person and edits a joint after double click", async () => {
    const onGenerate = vi.fn();
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        onGenerate,
        onApply: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Walking" }));
    const canvas = screen.getByRole("img", { name: "Pose canvas" });
    Object.defineProperty(canvas, "getScreenCTM", {
      value: () => ({ inverse: () => ({}) }),
    });
    Object.defineProperty(canvas, "createSVGPoint", {
      value: () => {
        const point = {
          x: 0,
          y: 0,
          matrixTransform: () => ({ x: point.x * 2.5, y: point.y * 2.5 }),
        };
        return point;
      },
    });
    Object.defineProperty(canvas, "hasPointerCapture", { value: () => true });
    Object.defineProperty(canvas, "setPointerCapture", {
      value: () => undefined,
    });
    const person = screen.getByRole("button", { name: "Pose 1" });
    fireEvent(
      person,
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 200,
        clientY: 200,
      }),
    );
    fireEvent(
      canvas,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 280,
        clientY: 200,
      }),
    );
    fireEvent(canvas, new MouseEvent("pointerup", { bubbles: true }));
    fireEvent.doubleClick(person);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    const joint = person.querySelectorAll("circle")[4]!;
    fireEvent(
      joint,
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 280,
        clientY: 200,
      }),
    );
    fireEvent(
      canvas,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 300,
        clientY: 180,
      }),
    );
    fireEvent(canvas, new MouseEvent("pointerup", { bubbles: true }));
    fireEvent.click(canvas);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Joint" }), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Joint horizontal" }), {
      target: { value: "0.1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open in Pose chat" }));
    await waitFor(() => expect(onGenerate).toHaveBeenCalled());
    const map = onGenerate.mock.calls[0]![0];
    expect(map.people[0].x).toBeGreaterThan(0.5);
    expect(map.people[0].joints).toHaveLength(18);
    expect(map.people[0].joints[4].x).toBe(0.1);
  });

  it("protects default templates and saves editable copies", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        onGenerate: vi.fn(),
        onApply,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    fireEvent.click(screen.getByRole("button", { name: /^Edit Standing$/ }));
    expect(screen.getByLabelText("Pose name")).toHaveProperty(
      "value",
      "Standing copy",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      JSON.parse(localStorage.getItem("machdoch.pose-templates.v1") ?? "[]"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Standing" }));
    expect(
      screen.getByRole("button", { name: "Edit Standing copy" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Standing" }));
    expect(
      screen.getByRole("button", { name: "Edit Standing copy 2" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Standing copy" }));
    fireEvent.change(screen.getByLabelText("Map Strength"), {
      target: { value: "1.35" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onApply).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save as new pose" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save as new pose" }));
    fireEvent.change(screen.getByLabelText("Pose name"), {
      target: { value: "My pose" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit My pose" })).toBeTruthy(),
    );
    const templates = JSON.parse(
      localStorage.getItem("machdoch.pose-templates.v1") ?? "[]",
    );
    expect(templates).toHaveLength(3);
    expect(templates[0].guidance.strength).toBe(1.35);
  });

  it("saves two figures as one reusable pose", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        onGenerate: vi.fn(),
        onApply,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Standing" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Sitting" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as new pose" }));
    fireEvent.change(screen.getByLabelText("Pose name"), {
      target: { value: "Duo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onApply).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Duo" })).toBeTruthy(),
    );
    expect(
      JSON.parse(localStorage.getItem("machdoch.pose-templates.v1") ?? "[]")[0]
        .people,
    ).toHaveLength(2);
  });

  it("finds, edits, and deletes a duplicated pose while keeping presets protected", () => {
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        onGenerate: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    expect(
      screen.queryByRole("button", { name: "Delete Standing" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Standing" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search poses" }), {
      target: { value: "copy" },
    });
    expect(screen.queryByRole("button", { name: "Add Standing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Standing copy" }));
    expect(screen.getByRole("button", { name: "Pose 1" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Standing copy" }),
    );
    expect(
      screen.queryByRole("button", { name: "Add Standing copy" }),
    ).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("machdoch.pose-templates.v1") ?? "[]"),
    ).toHaveLength(0);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search poses" }), {
      target: { value: "" },
    });
    expect(screen.getByRole("button", { name: "Add Standing" })).toBeTruthy();
  });

  it("keeps a failed apply editable", async () => {
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        onGenerate: vi.fn(),
        onApply: vi.fn().mockRejectedValue(new Error("Storage unavailable")),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Standing" }));
    fireEvent.click(screen.getByRole("button", { name: "Use pose map" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveProperty(
        "textContent",
        "Storage unavailable",
      ),
    );
    expect(screen.getByRole("button", { name: "Pose 1" })).toBeTruthy();
    expect(localStorage.getItem("machdoch.pose-templates.v1")).toBeNull();
  });

  it("keeps hidden figures in the applied map and shows the final preview", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "9:16",
        onGenerate: vi.fn(),
        onApply,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Standing" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Climbing" }));
    fireEvent.click(screen.getByRole("button", { name: "Select pose 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(
      screen.getAllByRole("button", { name: /^Pose [1-2]$/ }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Use pose map" }));
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          aspectRatio: "9:16",
          people: [
            expect.objectContaining({
              pose: "standing",
              x: 0.5,
              scale: expect.any(Number),
            }),
            expect.objectContaining({
              pose: "climbing",
              x: 0.18,
              scale: expect.any(Number),
            }),
          ],
        }),
      ),
    );
    expect(onApply.mock.calls[0]![0].people[0].scale).toBe(0.8);
    expect(screen.getByRole("button", { name: "Edit pose map" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Pose map" })).toBeNull();
  });

  it("makes a chat scene editable under a new name", async () => {
    const onRenamePoseScene = vi.fn();
    const scene = {
      aspectRatio: "4:5" as const,
      people: [
        {
          pose: "climbing" as const,
          x: 0.5,
          y: 0.9,
          scale: 0.5,
          mirror: false,
        },
      ],
    };
    render(
      createElement(MediaPoseWorkspace, {
        aspectRatio: "1:1",
        savedScenes: [{ id: "chat-1", label: "Create a pose", map: scene }],
        onRenamePoseScene,
        onGenerate: vi.fn(),
        onApply: vi.fn().mockResolvedValue(undefined),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pose map" }));
    expect(screen.getByText("Pose chat scene")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Rename Create a pose" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Scene name" }), {
      target: { value: "Climbing scene" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenamePoseScene).toHaveBeenCalledWith("chat-1", "Climbing scene");
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate Create a pose" }),
    );
    expect(
      screen.getByRole("button", { name: "Edit Create a pose copy" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Create a pose" }));
    expect(screen.getByLabelText("Pose name")).toHaveProperty(
      "value",
      "Create a pose copy 2",
    );
    fireEvent.change(screen.getByLabelText("Pose name"), {
      target: { value: "Climber" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit Climber" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Edit Create a pose" }),
    ).toBeTruthy();
  });
});
