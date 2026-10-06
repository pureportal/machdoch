import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionArchive } from "./use-session-archive";

afterEach(cleanup);

it("imports a selected file after a background refresh and prevents overlapping transfers", async () => {
  let complete: () => void = () => {};
  const source = {
    index: vi.fn(),
    export: vi.fn(),
    import: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    ),
  };
  const onImported = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ disabled }) =>
      useSessionArchive({
        source,
        sessionIds: ["visible"],
        disabled,
        onImported,
      }),
    { initialProps: { disabled: false } },
  );
  const file = new File(["{}"], "sessions.json", { type: "application/json" });
  rerender({ disabled: true });
  let importing: Promise<void>;
  act(() => {
    importing = result.current.importFile(file);
  });
  await act(async () => {
    await result.current.importFile(file);
  });
  expect(source.import).toHaveBeenCalledExactlyOnceWith(file);
  await act(async () => {
    complete();
    await importing!;
  });
  expect(onImported).toHaveBeenCalledOnce();
  rerender({ disabled: false });
  expect(result.current.disabled).toBe(false);
});

it("reports failed imports and permits a later retry", async () => {
  const source = {
    index: vi.fn(),
    export: vi.fn(),
    import: vi
      .fn()
      .mockRejectedValueOnce(new Error("Archive is not valid JSON."))
      .mockResolvedValueOnce(undefined),
  };
  const onImported = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useSessionArchive({ source, sessionIds: [], disabled: false, onImported }),
  );
  const file = new File(["{}"], "sessions.json");
  await act(async () => {
    await result.current.importFile(file);
  });
  expect(result.current.error).toBe("Archive is not valid JSON.");
  expect(onImported).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.importFile(file);
  });
  expect(result.current.error).toBeNull();
  expect(onImported).toHaveBeenCalledOnce();
});
