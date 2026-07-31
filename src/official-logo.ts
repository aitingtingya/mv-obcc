// Official Obsidian logo extraction from the local installation. The logo is
// never shipped with the plugin: on Windows it is read from the running
// Obsidian.exe PE resources (RT_GROUP_ICON -> RT_ICON), on macOS from
// Obsidian.app/Contents/Resources/icon.icns. Only PNG payloads are accepted.
// Every failure path returns null so callers can fall back to the drawn gem
// badge; nothing here throws or blocks.

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function isPng(buf: Buffer): boolean {
  return buf.length >= 4 && PNG_SIGNATURE.every((byte, i) => buf[i] === byte);
}

// ---------------------------------------------------------------------------
// .ico container (ICONDIR + 16-byte entries, payload offset from file start).
// ---------------------------------------------------------------------------

export interface IcoGroupEntry {
  size: number;
  data: Buffer;
}

/** Pure: parses an .ico file into size/payload pairs. Invalid -> []. */
export function parseIcoGroup(buf: Buffer): IcoGroupEntry[] {
  if (buf.length < 6) return [];
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return [];
  const count = buf.readUInt16LE(4);
  if (count === 0) return [];
  const entries: IcoGroupEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    if (base + 16 > buf.length) break;
    const bytesInRes = buf.readUInt32LE(base + 8);
    const imageOffset = buf.readUInt32LE(base + 12);
    if (bytesInRes === 0 || imageOffset + bytesInRes > buf.length) continue;
    entries.push({
      size: buf[base] === 0 ? 256 : buf[base]!,
      data: buf.subarray(imageOffset, imageOffset + bytesInRes),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// .icns container (magic + big-endian chunks of type/length/data).
// ---------------------------------------------------------------------------

export interface IcnsChunk {
  type: string;
  data: Buffer;
}

/** Pure: parses an .icns file into typed chunks. Invalid -> []. */
export function parseIcns(buf: Buffer): IcnsChunk[] {
  if (buf.length < 8 || buf.toString("ascii", 0, 4) !== "icns") return [];
  const limit = Math.min(buf.readUInt32BE(4), buf.length);
  const chunks: IcnsChunk[] = [];
  let offset = 8;
  while (offset + 8 <= limit) {
    const type = buf.toString("ascii", offset, offset + 4);
    const length = buf.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > limit) break;
    chunks.push({ type, data: buf.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// PE resource reader (Windows). Only the headers and the .rsrc section are
// loaded; the multi-hundred-MB executable body is never read into memory.
// ---------------------------------------------------------------------------

const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_SECTION_BYTES = 64 * 1024 * 1024;

interface PeSection {
  virtualAddress: number;
  rawOffset: number;
  rawSize: number;
}

function readAt(fd: number, position: number, length: number): Buffer | null {
  if (length <= 0 || length > MAX_SECTION_BYTES) return null;
  const buf = Buffer.alloc(length);
  return readSync(fd, buf, 0, length, position) === length ? buf : null;
}

function locateResourceSection(fd: number): PeSection | null {
  const dosHeader = readAt(fd, 0, 4096);
  if (!dosHeader || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) return null;
  const peOffset = dosHeader.readUInt32LE(0x3c);
  const fixed = readAt(fd, peOffset, 24);
  if (!fixed || fixed.readUInt32LE(0) !== PE_SIGNATURE) return null;
  const numberOfSections = fixed.readUInt16LE(6);
  const sizeOfOptionalHeader = fixed.readUInt16LE(20);
  if (numberOfSections < 1 || numberOfSections > 96) return null;
  const table = readAt(fd, peOffset + 24 + sizeOfOptionalHeader, numberOfSections * 40);
  if (!table) return null;
  for (let i = 0; i < numberOfSections; i++) {
    const base = i * 40;
    const name = table.toString("ascii", base, base + 8).replace(/\0.*$/, "");
    if (name !== ".rsrc") continue;
    const virtualAddress = table.readUInt32LE(base + 12);
    const rawSize = table.readUInt32LE(base + 16);
    const rawOffset = table.readUInt32LE(base + 20);
    if (rawSize === 0 || rawSize > MAX_SECTION_BYTES) return null;
    return { virtualAddress, rawOffset, rawSize };
  }
  return null;
}

interface ResourceEntry {
  id: number | null; // null for named entries (we only follow id entries)
  isDirectory: boolean;
  offset: number; // relative to the start of the .rsrc section
}

/** Walks the in-memory .rsrc section: Type -> Name -> Language -> data. */
class ResourceSection {
  constructor(
    private readonly buf: Buffer,
    private readonly virtualAddress: number,
  ) {}

  private directoryEntries(dirOffset: number): ResourceEntry[] {
    if (dirOffset < 0 || dirOffset + 16 > this.buf.length) return [];
    const named = this.buf.readUInt16LE(dirOffset + 12);
    const ids = this.buf.readUInt16LE(dirOffset + 14);
    const total = named + ids;
    if (total < 1 || total > 4096) return [];
    const entries: ResourceEntry[] = [];
    for (let i = 0; i < total; i++) {
      const base = dirOffset + 16 + i * 8;
      if (base + 8 > this.buf.length) break;
      const nameRaw = this.buf.readUInt32LE(base);
      const offsetRaw = this.buf.readUInt32LE(base + 4);
      entries.push({
        id: (nameRaw & 0x80000000) !== 0 ? null : nameRaw & 0xffff,
        isDirectory: (offsetRaw & 0x80000000) !== 0,
        offset: offsetRaw & 0x7fffffff,
      });
    }
    return entries;
  }

  private findChild(dirOffset: number, wantedId: number): ResourceEntry | null {
    return this.directoryEntries(dirOffset).find((e) => e.id === wantedId) ?? null;
  }

  private firstChild(dirOffset: number): ResourceEntry | null {
    return this.directoryEntries(dirOffset)[0] ?? null;
  }

  private dataAt(entry: ResourceEntry): Buffer | null {
    if (entry.isDirectory || entry.offset + 16 > this.buf.length) return null;
    // IMAGE_RESOURCE_DATA_ENTRY: OffsetToData is an RVA, then Size.
    const rva = this.buf.readUInt32LE(entry.offset);
    const size = this.buf.readUInt32LE(entry.offset + 4);
    const sectionOffset = rva - this.virtualAddress;
    if (size === 0 || sectionOffset < 0 || sectionOffset + size > this.buf.length) {
      return null;
    }
    return this.buf.subarray(sectionOffset, sectionOffset + size);
  }

  /** Data bytes for Type -> (given Name id, or first) -> first Language. */
  readResource(typeId: number, nameId: number | null): Buffer | null {
    const typeEntry = this.findChild(0, typeId);
    if (!typeEntry?.isDirectory) return null;
    const nameEntry = nameId === null
      ? this.firstChild(typeEntry.offset)
      : this.findChild(typeEntry.offset, nameId);
    if (!nameEntry?.isDirectory) return null;
    const langEntry = this.firstChild(nameEntry.offset);
    if (!langEntry || langEntry.isDirectory) return null;
    return this.dataAt(langEntry);
  }
}

interface GroupIconEntry {
  size: number;
  bytesInRes: number;
  resourceId: number;
}

/** Pure: parses a GRPICONDIR payload (14-byte entries, ends with nID). */
export function parseGroupIconDir(buf: Buffer): GroupIconEntry[] {
  if (buf.length < 6) return [];
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return [];
  const count = buf.readUInt16LE(4);
  if (count < 1 || count > 256) return [];
  const entries: GroupIconEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 14;
    if (base + 14 > buf.length) break;
    entries.push({
      size: buf[base] === 0 ? 256 : buf[base]!,
      bytesInRes: buf.readUInt32LE(base + 8),
      resourceId: buf.readUInt16LE(base + 12),
    });
  }
  return entries;
}

/**
 * Extracts the application icon of a Windows executable as PNG bytes: picks
 * the largest PNG-compressed entry of the first RT_GROUP_ICON and resolves
 * it through RT_ICON. Null when anything is missing or malformed.
 */
export function extractWindowsExeIconPng(exePath: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(exePath, "r");
    const section = locateResourceSection(fd);
    if (!section) return null;
    const raw = readAt(fd, section.rawOffset, section.rawSize);
    if (!raw) return null;
    const resources = new ResourceSection(raw, section.virtualAddress);
    const group = resources.readResource(RT_GROUP_ICON, null);
    if (!group) return null;
    const candidates = parseGroupIconDir(group).sort((a, b) => b.size - a.size);
    for (const candidate of candidates) {
      const data = resources.readResource(RT_ICON, candidate.resourceId);
      if (data && data.length === candidate.bytesInRes && isPng(data)) {
        return Buffer.from(data); // copy: releases the whole section buffer
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// macOS .icns reader.
// ---------------------------------------------------------------------------

const ICNS_TYPE_PREFERENCE = ["ic08", "ic09", "ic07", "ic10"];

/**
 * Extracts the app icon of a macOS .app bundle as PNG bytes. `execPath` is
 * expected at <App>.app/Contents/MacOS/<bin>; the icon lives at
 * <App>.app/Contents/Resources/icon.icns.
 */
export function extractMacAppIconPng(execPath: string): Buffer | null {
  try {
    const icnsPath = join(dirname(execPath), "..", "Resources", "icon.icns");
    if (!existsSync(icnsPath)) return null;
    const chunks = parseIcns(readFileSync(icnsPath));
    for (const type of ICNS_TYPE_PREFERENCE) {
      const chunk = chunks.find((c) => c.type === type);
      if (chunk && isPng(chunk.data)) return Buffer.from(chunk.data);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cached platform dispatch.
// ---------------------------------------------------------------------------

let cachedDataUrl: string | null | undefined;

/**
 * Best-effort official Obsidian logo as a PNG data URL, computed once per
 * session. Null when the logo cannot be located or decoded; callers fall
 * back to the drawn gem badge.
 */
export function officialLogoPngDataUrl(): string | null {
  if (cachedDataUrl !== undefined) return cachedDataUrl;
  let png: Buffer | null = null;
  try {
    if (process.platform === "win32") {
      png = extractWindowsExeIconPng(process.execPath);
    } else if (process.platform === "darwin") {
      png = extractMacAppIconPng(process.execPath);
    }
  } catch {
    png = null;
  }
  cachedDataUrl = png ? `data:image/png;base64,${png.toString("base64")}` : null;
  return cachedDataUrl;
}
