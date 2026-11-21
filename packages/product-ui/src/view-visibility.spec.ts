import { afterEach, expect, it, vi } from "vitest";
import { pollWhileVisible, viewVisibilityMessage } from "./view-visibility";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("pauses while the tab or the embedding view is hidden and refreshes when shown", async () => {
  vi.useFakeTimers();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const parent = frame.contentWindow!;
  vi.spyOn(window, "parent", "get").mockReturnValue(parent);
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const post = (visible: boolean) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: parent,
        data: { type: viewVisibilityMessage, visible },
      }),
    );
  const task = vi.fn().mockResolvedValue(undefined);
  const stop = pollWhileVisible(task, 1_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(task).toHaveBeenCalledTimes(1);

  hidden = true;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(1);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(task).toHaveBeenCalledTimes(2);

  post(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(2);
  post(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(task).toHaveBeenCalledTimes(3);

  stop();
  await vi.advanceTimersByTimeAsync(5_000);
  post(false);
  post(true);
  expect(task).toHaveBeenCalledTimes(3);
  frame.remove();
});

it("reads the next interval after each run", async () => {
  vi.useFakeTimers();
  let delay = 1_000;
  const task = vi.fn(async () => {
    delay = 10_000;
  });
  const stop = pollWhileVisible(task, () => delay);
  await vi.advanceTimersByTimeAsync(0);
  expect(task).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
});
