// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MediaAssetRecord,
  MediaImageMask,
} from "../../../../core/media/contracts.js";
import { MediaImageMaskEditor } from "./media-image-mask-editor";

vi.mock("../media-runtime", () => ({
  readMediaAssetReferencePreview: vi.fn(() => new Promise(() => undefined)),
}));

const asset: MediaAssetRecord = {
  id: "asset:base",
  runId: "run:base",
  digest: "e".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 2_048,
  width: 1_600,
  height: 800,
  createdAt: "2026-08-20T10:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
};

const setCanvasGeometry = (canvas: HTMLCanvasElement): void => {
  Object.defineProperty(canvas, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 220,
      height: 200,
      left: 10,
      right: 410,
      top: 20,
      width: 400,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(canvas, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(canvas, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false),
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MediaImageMaskEditor", () => {
  it("stores scaled pointer coordinates and supports erasing and clearing", () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onChange = vi.fn();
    const view = render(
      createElement(MediaImageMaskEditor, { asset, value: null, onChange }),
    );
    const canvas = screen.getByLabelText(
      "Image edit mask canvas",
    ) as HTMLCanvasElement;
    setCanvasGeometry(canvas);

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 210,
      clientY: 70,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    const painted = onChange.mock.lastCall?.[0] as MediaImageMask;
    expect(painted.strokes[0]?.mode).toBe("paint");
    expect(painted.strokes[0]?.opacity).toBe(1);
    expect(painted.strokes[0]?.softness).toBe(0.35);
    expect(painted.strokes[0]?.points[0]?.x).toBeCloseTo(0.5);
    expect(painted.strokes[0]?.points[0]?.y).toBeCloseTo(0.25);

    view.rerender(
      createElement(MediaImageMaskEditor, {
        asset,
        value: painted,
        onChange,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 330,
      clientY: 170,
      pointerId: 2,
    });
    fireEvent.pointerUp(canvas, { pointerId: 2 });

    const erased = onChange.mock.lastCall?.[0] as MediaImageMask;
    expect(erased.strokes.at(-1)?.mode).toBe("erase");

    view.rerender(
      createElement(MediaImageMaskEditor, {
        asset,
        value: erased,
        onChange,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear mask" }));
    expect(onChange).toHaveBeenLastCalledWith({
      schemaVersion: 2,
      sourceAssetId: asset.id,
      inverted: false,
      strokes: [],
    });
  });

  it("stores graded brush controls in each stroke", () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onChange = vi.fn();
    render(
      createElement(MediaImageMaskEditor, {
        asset,
        value: {
          schemaVersion: 2,
          sourceAssetId: asset.id,
          inverted: false,
          strokes: [],
        },
        onChange,
      }),
    );
    fireEvent.change(screen.getByLabelText(/Strength/u), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText(/Soft edge/u), {
      target: { value: "80" },
    });
    const canvas = screen.getByLabelText(
      "Image edit mask canvas",
    ) as HTMLCanvasElement;
    setCanvasGeometry(canvas);
    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 210,
      clientY: 120,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    const graded = onChange.mock.lastCall?.[0] as MediaImageMask;
    expect(graded.strokes[0]?.opacity).toBe(0.45);
    expect(graded.strokes[0]?.softness).toBe(0.8);
  });
});
