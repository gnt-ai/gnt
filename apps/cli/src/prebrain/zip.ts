// Minimal local .zip extractor -- just enough of the format to unpack a
// Notion "Markdown & CSV" export, with no new dependency for it. Verified
// against Notion's own export docs (notion.com/help/export-your-content)
// plus real-world reports of the export's shape: nested folders mirroring
// the page tree, one .md per page with the page title suffixed by a
// 32-character hex page ID, one .csv per database, and an assets
// subfolder per page holding downloaded images/files. None of that is
// zip-format-specific -- it's just files in folders -- so this reader
// doesn't need to know about it; notion-export.ts walks the extracted
// tree the same way docs-dir.ts walks a user-pointed directory.
//
// Reads the central directory (not local headers) for entry metadata --
// central directory sizes are authoritative even when a zip was written
// with a data descriptor (general-purpose bit 3), which the local header
// alone can't be trusted for. Supports the two compression methods every
// mainstream zip writer defaults to: 0 (stored) and 8 (deflate). Does not
// support zip64 (>4GB archives or >65535 entries) or exotic compression
// methods (bzip2, LZMA, ...) -- unrealistic for a docs/notes export, and
// unsupported entries are skipped rather than crashing the whole extract.
import { inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 65535;

interface CentralDirEntry {
  compressionMethod: number;
  compressedSize: number;
  fileName: string;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD record sits at the very end of the file, but a zip comment
  // (0-65535 bytes) can follow it, so scan backward for the signature
  // rather than assuming it's the last 22 bytes.
  const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Not a valid zip file (no end-of-central-directory record found).");
}

function readCentralDirectory(buf: Buffer): CentralDirEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries: CentralDirEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Not a valid zip file (central directory entry signature mismatch).");
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const fileName = buf.toString("utf-8", offset + 46, offset + 46 + fileNameLength);

    entries.push({ compressionMethod, compressedSize, fileName, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(buf: Buffer, entry: CentralDirEntry): Buffer | null {
  if (buf.readUInt32LE(entry.localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`Not a valid zip file (local header signature mismatch for ${entry.fileName}).`);
  }
  const fileNameLength = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) return inflateRawSync(raw);
  return null; // unsupported compression method -- see module doc comment
}

// Guards against zip-slip: a malicious or malformed entry name using ".."
// or an absolute path to write outside destDir. Every entry's resolved
// path must stay a descendant of destDir.
function safeJoin(destDir: string, entryName: string): string {
  const resolved = normalize(join(destDir, entryName));
  if (resolved !== destDir && !resolved.startsWith(destDir + sep)) {
    throw new Error(`Zip entry escapes the extraction directory: ${entryName}`);
  }
  return resolved;
}

export function extractZip(zipPath: string, destDir: string): void {
  const buf = readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  const normalizedDest = normalize(destDir);

  for (const entry of entries) {
    if (entry.fileName.endsWith("/")) continue; // explicit directory entry, no data to write
    const outPath = safeJoin(normalizedDest, entry.fileName);
    const data = readEntryData(buf, entry);
    if (data === null) continue; // unsupported compression method -- skip this entry, keep extracting the rest

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }
}
