import { maximumBrandLogoLength } from "@/lib/organization-brand";

export const brandLogoTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

const logoSizes = [256, 192, 128, 96];

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This image could not be read."));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

export async function rasterizeBrandLogo(file: File): Promise<string> {
  if (!(brandLogoTypes as readonly string[]).includes(file.type))
    throw new Error("Choose a PNG, JPEG, WebP or SVG image.");
  const image = await loadImage(file);
  const width = image.naturalWidth || 256;
  const height = image.naturalHeight || 256;
  for (const size of logoSizes) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot process images.");
    const scale = Math.min(size / width, size / height);
    const drawnWidth = width * scale;
    const drawnHeight = height * scale;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      (size - drawnWidth) / 2,
      (size - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
    for (const quality of [0.92, 0.8]) {
      const encoded = canvas.toDataURL("image/webp", quality);
      if (encoded.length <= maximumBrandLogoLength) return encoded;
    }
  }
  throw new Error("This image is too detailed. Choose a simpler logo.");
}
