import { expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { pickedFileName, releaseFile } from "./media-platform";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

it("shows native picker names on Windows and Linux", () => {
  expect(pickedFileName("C:\\pictures\\portrait.png")).toBe("portrait.png");
  expect(pickedFileName("/home/user/pictures/portrait.png")).toBe(
    "portrait.png",
  );
});

it("preserves native source files when their picker owner releases them", async () => {
  await expect(
    releaseFile("C:/pictures/original.png"),
  ).resolves.toBeUndefined();
  expect(nativeInvoke).not.toHaveBeenCalled();
});
