import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../components/ui/button";
import { readMediaAssetReferencePreview } from "../media-runtime";
import {
  emptyMediaImageLayout, mediaImageLayoutError, orderedMediaImageElements, parseMediaImageLayout,
  resizeMediaImageLayout, type MediaImageBox, type MediaImageLayout, type MediaImageLayoutElement,
} from "../../../../core/media/image-layout.js";

const SUBJECT_ALPHA_THRESHOLD = 4;

export function MediaImageLayoutEditor({ value, onChange, assets = [] }: {
  value: MediaImageLayout;
  onChange: (layout: MediaImageLayout) => void;
  assets?: readonly { id: string; label: string }[];
}) {
  const [selectedId, select] = useState<string | null>(null);
  const editorId = useId();
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, { url: string; width: number; height: number; bounds: number[] }>>({});
  const assetIds = [...new Set(value.elements.flatMap((element) => element.kind === "object" && element.assetId ? [element.assetId] : []))].sort().join("\n");
  useEffect(() => {
    let active = true;
    const loaded: typeof previews = {};
    setPreviews({});
    void Promise.all(assetIds.split("\n").filter(Boolean).map(async (id) => {
      const blob = await readMediaAssetReferencePreview(id, 768);
      const bitmap = await createImageBitmap(blob);
      try {
        if (!active) return;
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image preview is unavailable.");
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let left = bitmap.width, top = bitmap.height, right = 0, bottom = 0;
        for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
          if (pixels[(y * bitmap.width + x) * 4 + 3] >= SUBJECT_ALPHA_THRESHOLD) {
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
          }
        }
        loaded[id] = { url: URL.createObjectURL(blob), width: bitmap.width, height: bitmap.height,
          bounds: right > left && bottom > top ? [left, top, right - left, bottom - top] : [0, 0, bitmap.width, bitmap.height] };
      } finally { bitmap.close(); }
    })).then(() => { if (active) setPreviews({ ...loaded }); })
      .catch((cause) => { if (active) setError(`Could not preview layout asset: ${String(cause)}`); });
    return () => { active = false; Object.values(loaded).forEach(({ url }) => URL.revokeObjectURL(url)); };
  }, [assetIds]);
  const [resizeMode, setResizeMode] = useState<"scale" | "anchor">("scale");
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; box: MediaImageBox; resize: boolean } | null>(null);
  const selected = value.elements.find((element) => element.id === selectedId);
  const ordered = orderedMediaImageElements(value);
  const update = (element: MediaImageLayoutElement) => onChange({ ...value, elements: value.elements.map((entry) => entry.id === element.id ? element : entry) });
  const point = (event: PointerEvent) => {
    const bounds = svg.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * value.canvas.width / bounds.width, y: (event.clientY - bounds.top) * value.canvas.height / bounds.height };
  };
  const start = (event: PointerEvent<SVGElement>, element: MediaImageLayoutElement, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    select(element.id);
    drag.current = { ...point(event), id: element.id, box: [...element.box], resize };
    svg.current!.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state) return;
    const element = value.elements.find((entry) => entry.id === state.id);
    if (!element) return;
    const current = point(event);
    const dx = Math.round(current.x - state.x);
    const dy = Math.round(current.y - state.y);
    const [x0, y0, x1, y1] = state.box;
    const x = Math.max(0, Math.min(value.canvas.width - (x1 - x0), x0 + dx));
    const y = Math.max(0, Math.min(value.canvas.height - (y1 - y0), y0 + dy));
    update({ ...element, box: state.resize
      ? [x0, y0, Math.max(x0 + 1, Math.min(value.canvas.width, x1 + dx)), Math.max(y0 + 1, Math.min(value.canvas.height, y1 + dy))]
      : [x, y, x + x1 - x0, y + y1 - y0] });
  };
  const add = (kind: MediaImageLayoutElement["kind"]) => {
    const base = { id: `element_${crypto.randomUUID().replaceAll("-", "")}`, description: "", box: [0, 0, Math.max(1, Math.round(value.canvas.width / 3)), Math.max(1, Math.round(value.canvas.height / 3))] as MediaImageBox, zIndex: ordered.length };
    const element: MediaImageLayoutElement = kind === "text"
      ? { ...base, kind, text: "Text", font: "Arial", fontSize: 32, color: "#111111", align: "left", direction: "ltr" }
      : kind === "shape" ? { ...base, kind, shape: "rectangle", color: "#e5e7eb" }
        : { ...base, kind, fit: "contain", cutout: true };
    onChange({ ...value, elements: [...ordered.map((entry, zIndex) => ({ ...entry, zIndex })), element] });
    select(element.id);
  };
  const remove = () => {
    onChange({ ...value, elements: value.elements.filter((entry) => entry.id !== selectedId),
      ...(value.relations ? { relations: value.relations.filter((relation) => relation.subjectId !== selectedId && relation.objectId !== selectedId) } : {}) });
    select(null);
  };
  const reorder = (offset: number) => {
    const index = ordered.findIndex((entry) => entry.id === selectedId);
    const other = index + offset;
    if (index < 0 || other < 0 || other >= ordered.length) return;
    [ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!];
    onChange({ ...value, elements: ordered.map((entry, zIndex) => ({ ...entry, zIndex })) });
  };
  const resize = (dimension: "width" | "height", size: number) => {
    try {
      onChange(resizeMediaImageLayout(value, dimension === "width" ? size : value.canvas.width, dimension === "height" ? size : value.canvas.height, resizeMode));
      setError(null);
    } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
  };
  const exportLayout = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "image-layout.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return <div className="space-y-3 text-sm [&_label]:space-y-1 [&_label]:text-muted-foreground [&_input:not([type=checkbox])]:rounded-md [&_input:not([type=checkbox])]:border [&_input:not([type=checkbox])]:bg-background [&_input:not([type=checkbox])]:px-2 [&_input:not([type=checkbox])]:py-1 [&_input]:text-foreground [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:bg-background [&_textarea]:p-2 [&_textarea]:text-foreground [&_select]:rounded-md [&_select]:border [&_select]:bg-background [&_select]:px-2 [&_select]:py-1 [&_select]:text-foreground" data-testid="image-layout-editor">
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" onClick={() => add("object")}>Add object</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => add("text")}>Add text</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => add("shape")}>Add shape</Button>
      <Button type="button" size="sm" variant="outline" onClick={exportLayout}>Export layout</Button>
      <label>Import layout<input type="file" accept="application/json,.json" className="block w-full" onChange={async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try { onChange(parseMediaImageLayout(JSON.parse(await file.text()))); select(null); setError(null); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        event.target.value = "";
      }} /></label>
    </div>
    <div className="flex flex-wrap gap-2">
      {(["width", "height"] as const).map((dimension) => <label key={dimension}>{dimension === "width" ? "Width" : "Height"}<input aria-label={`Canvas ${dimension}`} type="number" min={1} max={8192} key={`${dimension}-${value.canvas[dimension]}`} defaultValue={value.canvas[dimension]} onBlur={(event) => resize(dimension, Number(event.target.value))} className="block w-24" /></label>)}
      <label>Resize<select value={resizeMode} onChange={(event) => setResizeMode(event.target.value as "scale" | "anchor")}><option value="scale">Scale elements</option><option value="anchor">Keep positions</option></select></label>
      <label>Background<input type="color" disabled={!value.background} value={value.background?.slice(0, 7) ?? "#ffffff"} onChange={(event) => onChange({ ...value, background: event.target.value })} /></label>
      <label><input type="checkbox" checked={!value.background} onChange={(event) => {
        const { background: _, ...layout } = value;
        onChange(event.target.checked ? layout : { ...layout, background: "#ffffff" });
      }} />Transparent</label>
    </div>
    <label className="block">Caption<textarea className="block w-full" value={value.caption} onChange={(event) => onChange({ ...value, caption: event.target.value })} /></label>
    <svg ref={svg} aria-label="Image layout canvas" role="img" viewBox={`0 0 ${value.canvas.width} ${value.canvas.height}`} className="block w-full rounded-md border" style={{ maxWidth: 560 * value.canvas.width / value.canvas.height, aspectRatio: `${value.canvas.width}/${value.canvas.height}`, background: value.background ?? "conic-gradient(#e5e7eb 25%, #ffffff 0 50%, #e5e7eb 0 75%, #ffffff 0) 0 0 / 20px 20px", touchAction: "none" }}
      onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onPointerDown={() => select(null)}>
      {ordered.map((element) => {
        const [x, y, right, bottom] = element.box;
        const width = right - x, height = bottom - y;
        const clipId = `${editorId}-${element.id}`;
        const preview = element.kind === "object" && element.assetId ? previews[element.assetId] : undefined;
        return <g key={element.id} data-element-id={element.id} onPointerDown={(event) => start(event, element)} style={{ cursor: "move" }}>
          <defs><clipPath id={clipId}><rect x={x} y={y} width={width} height={height} /></clipPath></defs>
          <g clipPath={`url(#${clipId})`} opacity={element.opacity ?? 1}>
          {element.kind !== "shape" || element.shape === "rectangle" ? <rect x={x} y={y} width={width} height={height} fill={element.kind === "shape" ? element.color : element.kind === "object" && !preview ? "#dbeafe" : "transparent"} />
            : element.shape === "ellipse" ? <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} fill={element.color} />
              : <path transform={`translate(${x} ${y})`} d={`M0 ${height * .35} H${width * .65} V0 L${width} ${height / 2} L${width * .65} ${height} V${height * .65} H0 Z`} fill={element.color} />}
          {element.kind === "object" && preview && <svg x={x} y={y} width={width} height={height}
            viewBox={(element.cutout !== false ? preview.bounds : [0, 0, preview.width, preview.height]).join(" ")}
            preserveAspectRatio={element.fit === "stretch" ? "none" : element.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"}>
            <image href={preview.url} width={preview.width} height={preview.height} />
          </svg>}
          {element.kind === "text" && <text x={element.align === "center" ? (x + right) / 2 : element.align === "right" ? right : x} y={y + element.fontSize} fontFamily={element.font} fontSize={element.fontSize} fill={element.color} textAnchor={element.align === "center" ? "middle" : element.align === "right" ? "end" : "start"} direction={element.direction} xmlSpace="preserve">{element.text.split("\n").map((line, index) => <tspan key={index} x={element.align === "center" ? (x + right) / 2 : element.align === "right" ? right : x} dy={index ? "1.2em" : 0}>{line}</tspan>)}</text>}
          </g>
          <rect x={x} y={y} width={right - x} height={bottom - y} fill="transparent" stroke={element.id === selectedId ? "#2563eb" : "#94a3b8"} strokeWidth={element.id === selectedId ? 3 : 1} />
          {element.id === selectedId && <rect aria-label="Resize element" x={right - 12} y={bottom - 12} width={12} height={12} fill="#2563eb" style={{ cursor: "nwse-resize" }} onPointerDown={(event) => start(event, element, true)} />}
        </g>;
      })}
    </svg>
    <label>Layer<select aria-label="Layer" className="block w-full" value={selectedId ?? ""} onChange={(event) => select(event.target.value || null)}><option value="">Select element</option>{[...ordered].reverse().map((element) => <option key={element.id} value={element.id}>{element.kind === "text" ? element.text : element.description || element.id}</option>)}</select></label>
    {selected && <div className="space-y-2">
      <label className="block">Description<textarea className="block w-full" value={selected.description} onChange={(event) => update({ ...selected, description: event.target.value })} /></label>
      <div className="flex flex-wrap gap-2">{selected.box.map((coordinate, index) => <label key={index}>{["Left", "Top", "Right", "Bottom"][index]}<input className="block w-20" type="number" value={coordinate} onChange={(event) => {
        const box = [...selected.box] as MediaImageBox;
        box[index] = Number(event.target.value);
        update({ ...selected, box });
      }} /></label>)}</div>
      {selected.kind === "object" && <>
        <label>Asset<select aria-label="Asset" value={selected.assetId ?? ""} onChange={(event) => { const { assetId: _, ...rest } = selected; update(event.target.value ? { ...rest, assetId: event.target.value } : rest); }}><option value="">Generate</option>{selected.assetId && !assets.some((asset) => asset.id === selected.assetId) && <option value={selected.assetId}>Selected asset</option>}{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label>
        <label>Fit<select aria-label="Fit" value={selected.fit ?? "contain"} onChange={(event) => update({ ...selected, fit: event.target.value as "contain" | "cover" | "stretch" })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></label>
        <label><input type="checkbox" checked={selected.cutout !== false} onChange={(event) => update({ ...selected, cutout: event.target.checked })} />Cut out subject</label>
      </>}
      {selected.kind === "text" && <>
        <label className="block">Text<textarea aria-label="Text" className="block w-full" value={selected.text} onChange={(event) => update({ ...selected, text: event.target.value })} /></label>
        <label>Font<input value={selected.font} onChange={(event) => update({ ...selected, font: event.target.value })} /></label>
        <label>Size<input type="number" min={1} max={1024} value={selected.fontSize} onChange={(event) => update({ ...selected, fontSize: Number(event.target.value) })} /></label>
        <label>Align<select value={selected.align} onChange={(event) => update({ ...selected, align: event.target.value as "left" | "center" | "right" })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
        <label>Direction<select value={selected.direction} onChange={(event) => update({ ...selected, direction: event.target.value as "ltr" | "rtl" })}><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>
      </>}
      {selected.kind === "shape" && <label>Shape<select aria-label="Shape" value={selected.shape} onChange={(event) => update({ ...selected, shape: event.target.value as "rectangle" | "ellipse" | "arrow" })}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="arrow">Arrow</option></select></label>}
      {selected.kind !== "object" && <label>Color<input type="color" value={selected.color.slice(0, 7)} onChange={(event) => update({ ...selected, color: event.target.value })} /></label>}
      <label>Opacity<input type="number" min={0} max={1} step={0.05} value={selected.opacity ?? 1} onChange={(event) => update({ ...selected, opacity: Number(event.target.value) })} /></label>
      <div className="flex gap-3"><Button type="button" size="sm" variant="outline" onClick={() => reorder(1)}>Bring forward</Button><Button type="button" size="sm" variant="outline" onClick={() => reorder(-1)}>Send backward</Button><Button type="button" size="sm" variant="outline" onClick={remove}>Delete element</Button></div>
    </div>}
    {(error || mediaImageLayoutError(value)) && <p role="alert">{error || mediaImageLayoutError(value)}</p>}
  </div>;
}

export { emptyMediaImageLayout };
