// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appControl } from "@machdoch/media-studio/tauri/ui/app-control/app-control-registry.js";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: tauri.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      tauri.handlers.set(event, handler);
      return () => tauri.handlers.delete(event);
    },
  ),
}));
vi.mock("../lib/shell-store", () => ({
  getCurrentShellWindowLabel: () => "main",
}));

const { useAppControlBridge } = await import("./use-app-control-bridge");

const request = (event: { payload: unknown }): void =>
  tauri.handlers.get("machdoch://app-control-request")?.(event);

afterEach(cleanup);

describe("useAppControlBridge", () => {
  it("attaches the main window and answers snapshot and action requests", async () => {
    const unregister = appControl.register("media", 1, () => ({
      location: ["Media Studio", "Basic"],
      actions: [
        {
          id: "media.set_prompt",
          description: "Set the prompt.",
          effect: "write",
          input: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
          },
          run: (input) => ({ prompt: input.prompt }),
        },
      ],
    }));
    renderHook(() => useAppControlBridge());
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("attach_app_control"),
    );

    request({
      payload: {
        id: "app-control:1",
        request: {
          kind: "run",
          actionId: "media.set_prompt",
          input: { prompt: "lara croft" },
          mode: "machdoch",
        },
      },
    });
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        "complete_app_control_request",
        {
          id: "app-control:1",
          result: {
            result: { prompt: "lara croft" },
            location: ["Media Studio", "Basic"],
          },
          error: null,
        },
      ),
    );

    request({
      payload: {
        id: "app-control:2",
        request: {
          kind: "run",
          actionId: "media.set_prompt",
          input: {},
          mode: "machdoch",
        },
      },
    });
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        "complete_app_control_request",
        {
          id: "app-control:2",
          result: null,
          error:
            'Invalid input for media.set_prompt: Input "prompt" is required.',
        },
      ),
    );

    request({
      payload: { id: "app-control:3", request: { kind: "snapshot" } },
    });
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        "complete_app_control_request",
        expect.objectContaining({
          id: "app-control:3",
          result: expect.objectContaining({
            location: ["Media Studio", "Basic"],
          }),
        }),
      ),
    );
    unregister();
  });

  it("reports actions that became available after an action", async () => {
    let unregisterMedia = (): void => undefined;
    const unregister = appControl.register("app", 0, () => ({
      location: ["Chat"],
      actions: [
        {
          id: "app.open_view",
          description: "Open a view.",
          effect: "write",
          input: { type: "object", properties: {} },
          run: () => {
            unregisterMedia = appControl.register("media", 1, () => ({
              location: ["Basic"],
              actions: [
                {
                  id: "media.generate",
                  description: "Generate.",
                  effect: "write",
                  input: { type: "object", properties: {} },
                  run: () => null,
                },
              ],
            }));
            return { view: "Media Studio" };
          },
        },
      ],
    }));
    tauri.invoke.mockClear();
    renderHook(() => useAppControlBridge());
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("attach_app_control"),
    );
    request({
      payload: {
        id: "app-control:5",
        request: {
          kind: "run",
          actionId: "app.open_view",
          input: {},
          mode: "machdoch",
        },
      },
    });
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        "complete_app_control_request",
        {
          id: "app-control:5",
          result: {
            result: { view: "Media Studio" },
            location: ["Chat", "Basic"],
            newActions: [
              expect.objectContaining({
                id: "media.generate",
                effect: "write",
              }),
            ],
          },
          error: null,
        },
      ),
    );
    unregisterMedia();
    unregister();
  });

  it("aborts cancelled actions, skips their answer, and detaches on unmount", async () => {
    let aborted = false;
    let started = false;
    const unregister = appControl.register("media", 1, () => ({
      location: [],
      actions: [
        {
          id: "media.install",
          description: "Install.",
          effect: "write",
          input: { type: "object", properties: {} },
          run: (_input, { signal }) =>
            new Promise((_resolve, reject) => {
              started = true;
              signal.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("stopped"));
              });
            }),
        },
      ],
    }));
    tauri.invoke.mockClear();
    const hook = renderHook(() => useAppControlBridge());
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("attach_app_control"),
    );
    request({
      payload: {
        id: "app-control:9",
        request: {
          kind: "run",
          actionId: "media.install",
          input: {},
          mode: "machdoch",
        },
      },
    });
    await waitFor(() => expect(started).toBe(true));
    tauri.handlers.get("machdoch://app-control-cancel")?.({
      payload: { id: "app-control:9" },
    });
    await waitFor(() => expect(aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      "complete_app_control_request",
      expect.anything(),
    );
    hook.unmount();
    expect(tauri.invoke).toHaveBeenCalledWith("detach_app_control");
    expect(tauri.handlers.size).toBe(0);
    unregister();
  });
});
