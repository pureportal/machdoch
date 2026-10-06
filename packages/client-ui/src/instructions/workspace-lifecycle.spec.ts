import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { InstructionRegistryResult } from "@machdoch/fleet-protocol/instruction-contract";
import { useInstructionManagement } from "./use-instruction-management";
import { createWorkspaceInstructionLifecycle } from "./workspace-lifecycle";

afterEach(cleanup);

const registry: InstructionRegistryResult = {
  schemaVersion: 2,
  revision: 8,
  profiles: [],
  workspaces: [{ id: "workspace", root: "/old", tags: [], scopes: [] }],
};
const relocation = {
  operation: "workspace-relink" as const,
  workspaceId: "workspace",
  root: "/new",
  expectedRevision: 8,
};

it("does not change workspace bindings when terminal cleanup fails", async () => {
  const mutate = vi.fn();
  const relinkWorkspace = vi.fn();
  const { result } = renderHook(() =>
    useInstructionManagement("/old", {
      loadRegistry: async () => registry,
      mutate,
      ...createWorkspaceInstructionLifecycle({
        stopTerminals: async () => {
          throw new Error("Terminal cleanup failed");
        },
        relinkWorkspace,
      }),
    }),
  );
  await act(() => result.current.onRefresh());
  await act(async () => {
    expect(await result.current.onSave(relocation)).toBe(false);
  });
  expect(mutate).not.toHaveBeenCalled();
  expect(relinkWorkspace).not.toHaveBeenCalled();
  expect(result.current.message?.text).toBe("Terminal cleanup failed");
});

it("preserves workspace history when the reviewed binding has changed", async () => {
  const relinkWorkspace = vi.fn();
  const stopTerminals = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useInstructionManagement("/old", {
      loadRegistry: async () => registry,
      mutate: async () => {
        throw new Error("The library changed. Refresh and try again.");
      },
      ...createWorkspaceInstructionLifecycle({
        stopTerminals,
        relinkWorkspace,
      }),
    }),
  );
  await act(() => result.current.onRefresh());
  await act(async () => {
    expect(await result.current.onSave(relocation)).toBe(false);
  });
  expect(stopTerminals).toHaveBeenCalledWith("/old");
  expect(relinkWorkspace).not.toHaveBeenCalled();
  expect(result.current.registry?.revision).toBe(8);
});

it("cleans terminals before moving bindings and updates history after the saved mutation", async () => {
  const steps: string[] = [];
  const { result } = renderHook(() =>
    useInstructionManagement("/old", {
      loadRegistry: async () => {
        steps.push("refresh");
        return registry;
      },
      mutate: async () => {
        steps.push("bindings");
        return { previousRevision: 8 };
      },
      ...createWorkspaceInstructionLifecycle({
        stopTerminals: async (root) => {
          expect(root).toBe("/old");
          steps.push("terminals");
        },
        relinkWorkspace: async (oldRoot, newRoot) => {
          expect([oldRoot, newRoot]).toEqual(["/old", "/new"]);
          steps.push("history");
        },
      }),
    }),
  );
  await act(() => result.current.onRefresh());
  steps.length = 0;
  await act(async () => {
    expect(await result.current.onSave(relocation)).toEqual({
      previousRevision: 8,
    });
  });
  expect(steps).toEqual(["terminals", "bindings", "history", "refresh"]);
});
