import { readSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/**
 * Read exactly the already-validated file size from an open descriptor.
 *
 * FileHandle.readFile() follows a growing EOF and can allocate far beyond a
 * pre-open size bound. Reading fixed positions keeps the allocation bounded;
 * callers still compare descriptor/path identity after this read.
 */
export const readOpenedFileExactly = async (
  handle: FileHandle,
  byteLength: number,
): Promise<Buffer> => {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Cannot read a file with an invalid bounded byte length.");
  }
  const bytes = Buffer.alloc(byteLength);
  let position = 0;
  while (position < byteLength) {
    const result = await handle.read(
      bytes,
      position,
      byteLength - position,
      position,
    );
    if (result.bytesRead === 0) {
      throw new Error("The file ended before its validated size was read.");
    }
    position += result.bytesRead;
  }
  return bytes;
};

export const readOpenedFileExactlySync = (
  descriptor: number,
  byteLength: number,
): Buffer => {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Cannot read a file with an invalid bounded byte length.");
  }
  const bytes = Buffer.alloc(byteLength);
  let position = 0;
  while (position < byteLength) {
    const bytesRead = readSync(
      descriptor,
      bytes,
      position,
      byteLength - position,
      position,
    );
    if (bytesRead === 0) {
      throw new Error("The file ended before its validated size was read.");
    }
    position += bytesRead;
  }
  return bytes;
};
