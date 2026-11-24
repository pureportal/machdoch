import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const { dropPointFromPhysical, nativeDropZoneAt } =
  await import("./native-drop-zones");

const zone = (left: number, top: number, right: number, bottom: number) => ({
  element: { getBoundingClientRect: () => ({ left, top, right, bottom }) },
  onHover: vi.fn(),
  onDrop: vi.fn(),
});

describe("native drop zones", () => {
  it("converts physical drop positions to CSS pixels", () => {
    expect(dropPointFromPhysical({ x: 300, y: 150 }, 1.5)).toEqual({
      x: 200,
      y: 100,
    });
  });

  it("finds the zone under the drop point", () => {
    const tree = zone(0, 0, 200, 600);
    const editor = zone(200, 0, 800, 600);
    expect(nativeDropZoneAt({ x: 250, y: 10 }, [tree, editor])).toBe(editor);
    expect(nativeDropZoneAt({ x: 50, y: 10 }, [tree, editor])).toBe(tree);
    expect(nativeDropZoneAt({ x: 900, y: 10 }, [tree, editor])).toBeNull();
  });
});
