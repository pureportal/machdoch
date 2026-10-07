import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRpmExecutable } from "./rpm-executable.mjs";

await test("marks the executable for RPM without changing platform matching constants", () => {
  const binary = Buffer.from(
    "prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0__TAURI_BUNDLE_TYPE_VAR_DEB\0suffix",
  );
  const result = prepareRpmExecutable(binary);
  assert.equal(result.length, binary.length);
  assert.equal(
    result.toString(),
    "prefix\0__TAURI_BUNDLE_TYPE_VAR_RPM\0__TAURI_BUNDLE_TYPE_VAR_DEB\0suffix",
  );
  assert.match(binary.toString(), /VAR_UNK/u);
});

await test("rejects missing and ambiguous bundle markers", () => {
  assert.throws(
    () => prepareRpmExecutable(Buffer.from("bundled")),
    /one unbundled/u,
  );
  assert.throws(
    () =>
      prepareRpmExecutable(
        Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK"),
      ),
    /one unbundled/u,
  );
});
