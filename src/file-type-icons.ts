// File-type icon generation. Pure logic with no DOM/Obsidian imports so the
// whole pipeline (SVG templates, PNG encoder, ICO/ICNS packers) is unit
// testable. Two icon families are produced:
// - OS icons (Windows/macOS file managers): white document + extension text
//   + the official Obsidian logo badge (drawn gem fallback when the logo
//   cannot be extracted from the local installation).
// - Obsidian-internal icons (tab headers): currentColor extension text that
//   follows the active theme. Emitted as inner SVG content laid out on a
//   100x100 box, which is the convention Obsidian's addIcon() expects (it
//   wraps the content in its own <svg viewBox="0 0 100 100"> root; a full
//   <svg> document here would nest and render nothing).

import { deflateSync } from "node:zlib";
import { t } from "./i18n";

/** Uppercase short label for an extension ("md" -> "MD"), null when empty. */
export function labelForExtension(extension: string): string | null {
  const normalized = extension.trim().replace(/^\.+/, "").toUpperCase();
  return normalized === "" ? null : normalized;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Faceted Obsidian-style gem, parameterized by center and size. The facets
 * tile the silhouette exactly: a light top trapezoid, two mid side triangles,
 * and three lower triangles, with a dark outline on top. Kept as the badge
 * fallback when the official logo cannot be extracted locally.
 */
function gemBadgeSvg(
  cx: number,
  cy: number,
  width: number,
  height: number,
  strokeWidth: number,
): string {
  const px = (fx: number) => (cx - width / 2 + fx * width).toFixed(1);
  const py = (fy: number) => (cy - height / 2 + fy * height).toFixed(1);
  const poly = (color: string, points: ReadonlyArray<readonly [number, number]>) =>
    `<polygon points="${points.map(([fx, fy]) => `${px(fx)},${py(fy)}`).join(" ")}" fill="${color}"/>`;
  const silhouette: ReadonlyArray<readonly [number, number]> = [
    [0.3, 0.06], [0.7, 0.06], [0.94, 0.34], [0.5, 0.97], [0.06, 0.34],
  ];
  return (
    poly("#C4B5FD", [[0.3, 0.06], [0.7, 0.06], [0.6, 0.34], [0.4, 0.34]]) +
    poly("#A78BFA", [[0.06, 0.34], [0.3, 0.06], [0.4, 0.34]]) +
    poly("#8B5CF6", [[0.7, 0.06], [0.94, 0.34], [0.6, 0.34]]) +
    poly("#7C3AED", [[0.06, 0.34], [0.4, 0.34], [0.5, 0.97]]) +
    poly("#8B5CF6", [[0.4, 0.34], [0.6, 0.34], [0.5, 0.97]]) +
    poly("#6D28D9", [[0.94, 0.34], [0.6, 0.34], [0.5, 0.97]]) +
    `<polygon points="${silhouette.map(([fx, fy]) => `${px(fx)},${py(fy)}`).join(" ")}" fill="none" stroke="#4C1D95" stroke-width="${strokeWidth}" stroke-linejoin="round" opacity="0.55"/>`
  );
}

function osGemBadge(): string {
  // Gem centered near the bottom-right document corner.
  return gemBadgeSvg(47, 46.5, 19, 21, 1);
}

function osLabelMetrics(label: string): { fontSize: number; textLength: number | null } {
  if (label.length <= 2) return { fontSize: 17, textLength: null };
  if (label.length === 3) return { fontSize: 15, textLength: null };
  if (label.length === 4) return { fontSize: 13, textLength: null };
  return { fontSize: 11, textLength: 34 };
}

/**
 * OS file-manager icon template: white rounded document with the extension
 * label in the middle and the official Obsidian logo (`logoDataUrl`) at the
 * bottom-right corner; falls back to the drawn gem when null.
 * `label = null` renders a generic document (no text).
 */
export function osFileTypeIconSvg(
  label: string | null,
  logoDataUrl?: string | null,
): string {
  const safeLabel = label === null ? null : escapeXml(label);
  let body: string;
  if (label === null) {
    body =
      `<line x1="19" y1="24" x2="45" y2="24" stroke="#D4D7DE" stroke-width="3" stroke-linecap="round"/>` +
      `<line x1="19" y1="32" x2="45" y2="32" stroke="#D4D7DE" stroke-width="3" stroke-linecap="round"/>` +
      `<line x1="19" y1="40" x2="36" y2="40" stroke="#D4D7DE" stroke-width="3" stroke-linecap="round"/>`;
  } else {
    const metrics = osLabelMetrics(label);
    const textLengthAttr = metrics.textLength === null
      ? ""
      : ` textLength="${metrics.textLength}" lengthAdjust="spacingAndGlyphs"`;
    body =
      `<text x="32" y="34" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="700" ` +
      `font-size="${metrics.fontSize}" fill="#3A3D46"${textLengthAttr}>${safeLabel}</text>`;
  }
  // The badge box matches the drawn gem's footprint (center 47,46.5, 19x21).
  const badge = logoDataUrl
    ? `<image href="${logoDataUrl}" x="37.5" y="36" width="19" height="21" preserveAspectRatio="xMidYMid meet"/>`
    : osGemBadge();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect x="9" y="3" width="46" height="58" rx="6" fill="#FFFFFF" stroke="#B9BDC7" stroke-width="2"/>` +
    body +
    badge +
    `</svg>`
  );
}

function obsidianLabelMetrics(label: string): {
  fontSize: number;
  textLength: number | null;
  boxWidth: number;
} {
  const len = label.length;
  // Monospace makes the width budget exact (0.6em per char). Short labels get
  // one fixed, icon-filling font size (80 on the 100-wide canvas); anything
  // wider than 86 units is compressed to fit, longer labels shrink instead.
  const fontSize = len <= 3 ? 80 : Math.max(14, Math.floor(86 / (0.6 * len)));
  const naturalWidth = 0.6 * fontSize * len;
  const textLength = naturalWidth > 86 ? 86 : null;
  const boxWidth = Math.min(94, Math.ceil(Math.min(naturalWidth, 86)) + 8);
  return { fontSize, textLength, boxWidth };
}

/**
 * Obsidian-internal icon template: the extension label in theme-following
 * (currentColor) monospace text inside a rounded outline frame that fills the
 * tab icon slot. Font size is fixed for short labels and the frame width
 * adapts to the label length, so MD/PY/TEX all render at the same large size.
 * Emitted as inner content on Obsidian's 100x100 addIcon() canvas, without an
 * <svg> wrapper.
 */
export function obsidianFileTypeIconSvg(label: string): string {
  const safeLabel = escapeXml(label);
  const { fontSize, textLength, boxWidth } = obsidianLabelMetrics(label);
  const boxX = 50 - boxWidth / 2;
  const textLengthAttr = textLength === null
    ? ""
    : ` textLength="${textLength}" lengthAdjust="spacingAndGlyphs"`;
  return (
    `<rect x="${boxX}" y="4" width="${boxWidth}" height="92" rx="12" ` +
    `stroke="currentColor" stroke-width="5" fill="none"/>` +
    `<text x="50" y="52" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="monospace" font-weight="700" font-size="${fontSize}" ` +
    `fill="currentColor"${textLengthAttr}>${safeLabel}</text>`
  );
}

// ---------------------------------------------------------------------------
// PNG encoder (RGBA input, filter-0 scanlines, zlib deflate, own CRC32).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Buffer {
  if (width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error(t("PNG 像素数据与尺寸不匹配。"));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      rowStart + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container (PNG payloads, supported since Vista).
// ---------------------------------------------------------------------------

export function packIco(images: { size: number; data: Buffer }[]): Buffer {
  if (images.length === 0) throw new Error(t("ICO 至少需要一个图像。"));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // resource type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries: Buffer[] = [];
  const payloads: Buffer[] = [];
  for (const { size, data } of images) {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(t("非法 ICO 尺寸：{v0}", { v0: size }));
    }
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 means 256
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(data);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

// ---------------------------------------------------------------------------
// ICNS container (PNG payloads, supported since macOS 10.7).
// ---------------------------------------------------------------------------

const ICNS_TYPE_BY_SIZE: Record<number, string> = {
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};

export function packIcns(images: { size: number; data: Buffer }[]): Buffer {
  if (images.length === 0) throw new Error(t("ICNS 至少需要一个图像。"));
  const chunks = images.map(({ size, data }) => {
    const type = ICNS_TYPE_BY_SIZE[size];
    if (!type) throw new Error(t("不支持的 ICNS 尺寸：{v0}", { v0: size }));
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const magic = Buffer.alloc(8);
  magic.write("icns", 0, "ascii");
  magic.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([magic, body]);
}
