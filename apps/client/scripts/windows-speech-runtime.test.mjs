import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCabinet } from "./windows-speech-runtime.mjs";

function cabinet(names) {
  const bytes = Buffer.alloc(
    44 + names.reduce((size, name) => size + 17 + Buffer.byteLength(name), 0),
  );
  bytes.write("MSCF");
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(44, 16);
  bytes[24] = 3;
  bytes[25] = 1;
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(names.length, 28);
  let offset = 44;
  for (const name of names) {
    bytes.writeUInt32LE(1, offset);
    bytes.write(name, offset + 16);
    offset += 17 + Buffer.byteLength(name);
  }
  return bytes;
}

await test("accepts flat runtime cabinet members", () => {
  assert.deepEqual(
    [...validateCabinet(cabinet(["a4", "msvcp140.dll_amd64"]))],
    ["a4", "msvcp140.dll_amd64"],
  );
});

await test("rejects traversal, absolute paths, and ambiguous filenames", () => {
  for (const name of [
    "../runtime.dll",
    "C:\\runtime.dll",
    "folder/runtime.dll",
    "..",
    ".",
    "",
  ]) {
    assert.throws(() => validateCabinet(cabinet([name])), /filename/);
  }
  assert.throws(
    () => validateCabinet(cabinet(["runtime.dll", "RUNTIME.dll"])),
    /filename/,
  );
});

await test("rejects corrupt headers and truncated file tables", () => {
  assert.throws(() => validateCabinet(Buffer.alloc(35)), /header/);
  const bytes = cabinet(["a4"]);
  bytes.writeUInt32LE(bytes.length + 1, 8);
  assert.throws(() => validateCabinet(bytes), /header/);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(bytes.length, 16);
  assert.throws(() => validateCabinet(bytes), /entry/);
});

await test("rejects spanned folders and excessive extraction size", () => {
  const bytes = cabinet(["a4"]);
  bytes.writeUInt16LE(0xffff, 52);
  assert.throws(() => validateCabinet(bytes), /entry/);
  bytes.writeUInt16LE(0, 52);
  bytes.writeUInt32LE(129 * 1024 * 1024, 44);
  assert.throws(() => validateCabinet(bytes), /contents/);
});
