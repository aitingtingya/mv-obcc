// DOM rasterization seam for OS file-type icons. Kept intentionally thin:
// SVG -> <img> -> offscreen canvas -> RGBA -> the pure encoders in
// file-type-icons.ts. Everything testable lives over there.

import {
  encodePng,
  osFileTypeIconSvg,
  packIcns,
  packIco,
} from "./file-type-icons";

export const ICO_ICON_SIZES = [16, 32, 48, 256] as const;
export const ICNS_ICON_SIZES = [128, 256, 512, 1024] as const;

async function rasterizeSvg(
  svg: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("文件类型图标 SVG 光栅化失败。"));
  });
  image.src = url;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图标光栅化画布。");
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Uint8Array(
    context.getImageData(0, 0, width, height).data.buffer.slice(0),
  );
}

async function renderPngs(
  label: string | null,
  sizes: readonly number[],
  logoDataUrl?: string | null,
): Promise<{ size: number; data: Buffer }[]> {
  const svg = osFileTypeIconSvg(label, logoDataUrl);
  const images: { size: number; data: Buffer }[] = [];
  for (const size of sizes) {
    const rgba = await rasterizeSvg(svg, size, size);
    images.push({ size, data: encodePng(rgba, size, size) });
  }
  return images;
}

/** Renders the OS-style icon for one extension into a multi-size ICO. */
export async function renderFileTypeIco(
  label: string | null,
  logoDataUrl?: string | null,
): Promise<Buffer> {
  return packIco(await renderPngs(label, ICO_ICON_SIZES, logoDataUrl));
}

/** Renders the OS-style icon for one extension into an ICNS resource. */
export async function renderFileTypeIcns(
  label: string | null,
  logoDataUrl?: string | null,
): Promise<Buffer> {
  return packIcns(await renderPngs(label, ICNS_ICON_SIZES, logoDataUrl));
}
