import { orderedMediaImageElements, parseMediaImageLayout, type MediaImageLayout } from "./image-layout.js";

export function compileMossImageLayout(input: MediaImageLayout): { prompt: string; elementIds: string[] } {
  const layout = parseMediaImageLayout(input);
  const { width, height } = layout.canvas;
  if (width % 16 || height % 16) throw new Error("MOSS canvas dimensions must be divisible by 16.");
  const elements = orderedMediaImageElements(layout);
  const prompt = JSON.stringify({
    summary: { meta: [], canvas: "single", caption: layout.caption },
    items: elements.map((element) => ({
      label: element.kind === "text" ? "text" : "object",
      caption: element.kind === "shape" ? `${element.description}\n${element.color} ${element.shape}` : element.description,
      ...(element.kind === "text" ? { text: element.text } : {}),
      bbox: [element.box[1] - height / 2, element.box[0] - width / 2,
        element.box[3] - height / 2, element.box[2] - width / 2],
    })),
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  });
  return { prompt, elementIds: elements.map((element) => element.id) };
}

export function compileFlux3ImageLayout(input: MediaImageLayout) {
  const layout = parseMediaImageLayout(input);
  const { width, height } = layout.canvas;
  if (width % 16 || height % 16) throw new Error("FLUX 3 canvas dimensions must be divisible by 16.");
  return orderedMediaImageElements(layout).map((element) => {
    const bbox = [element.box[1] / height, element.box[0] / width,
      element.box[3] / height, element.box[2] / width];
    const quantized = bbox.map((value) => {
      const scaled = value * 1000, floor = Math.floor(scaled);
      return scaled - floor === .5 ? floor + floor % 2 : Math.round(scaled);
    });
    if (quantized[0]! >= quantized[2]! || quantized[1]! >= quantized[3]!)
      throw new Error(`Enlarge ${element.id}; its box collapses in FLUX 3 coordinates.`);
    return {
      id: element.id,
      desc: element.kind === "text" ? `${element.description}\nLiteral text: ${JSON.stringify(element.text)}` : element.kind === "shape" ? `${element.description}\n${element.color} ${element.shape}` : element.description,
      bbox,
    };
  });
}
