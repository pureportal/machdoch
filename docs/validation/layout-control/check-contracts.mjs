import { build } from "vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const storage = process.argv[2];
if (!storage) throw new Error("Provide the configured storage root");
const directory = path.resolve(storage, "layout-control/evidence");
await mkdir(directory, { recursive: true });
const compiled = path.resolve(storage, "layout-control/compiler");
await build({ configFile: false, logLevel: "error", build: { outDir: compiled, emptyOutDir: false,
  lib: { entry: path.resolve("docs/validation/layout-control/workflow-api.ts"), formats: ["es"], fileName: () => "workflow-api.mjs" } } });
const api = await import(pathToFileURL(path.join(compiled, "workflow-api.mjs")));
const scene = JSON.parse(await readFile("docs/artifacts/layout-control-2026-10-18/scene.json", "utf8"));
const cases = [];
const add = (name, valid, edit) => {
  const layout = structuredClone(scene);
  edit?.(layout);
  cases.push({ name, valid, layout });
};
add("supplied scene", true);
add("overlap and equal layers", true, layout => { layout.elements[1].box = [...layout.elements[0].box]; layout.elements[1].zIndex = 0; });
add("opacity exponent", true, layout => { layout.elements[0].opacity = 0.0000001; });
add("duplicate ID", false, layout => { layout.elements[1].id = layout.elements[0].id; });
add("zero area", false, layout => { layout.elements[0].box[2] = layout.elements[0].box[0]; });
add("out of bounds", false, layout => { layout.elements[0].box[2] = 1025; });
add("fractional coordinate", false, layout => { layout.elements[0].box[0] = 1.5; });
add("negative coordinate", false, layout => { layout.elements[0].box[0] = -1; });
add("unknown field", false, layout => { layout.extra = true; });
add("boolean canvas", false, layout => { layout.canvas.width = true; });
add("boolean layer", false, layout => { layout.elements[0].zIndex = true; });
add("unknown relation", false, layout => { layout.relations[0].subjectId = "missing"; });
for (const field of ["background", "relations"]) add(`null ${field}`, false, layout => { layout[field] = null; });
for (const field of ["opacity", "assetId", "fit", "cutout", "text", "shape"]) add(`null ${field}`, false, layout => { layout.elements[0][field] = null; });
add("UTF16 caption limit", true, layout => { layout.caption = "\u{1f916}".repeat(8000); });
add("UTF16 caption overflow", false, layout => { layout.caption = "\u{1f916}".repeat(8001); });
add("UTF16 description overflow", false, layout => { layout.elements[0].description = "\u{1f916}".repeat(2001); });
add("literal text", true, layout => { layout.elements.push({ id: "title", kind: "text", description: "", box: [0, 0, 1000, 100], zIndex: 5,
  text: "  {{title}}\nGrüße — مرحبا", font: "Arial", fontSize: 28, color: "#112233", align: "left", direction: "rtl" }); });
const values = cases.map(test => test.layout);
const input = JSON.stringify(values);
const native = spawnSync(path.resolve(".cache/rust-layout/debug/machdoch-layout-verification.exe"), ["validate"], { input, encoding: "utf8", windowsHide: true });
assert.equal(native.status, 0, native.stderr);
const rust = JSON.parse(native.stdout);
const python = spawnSync(path.resolve("apps/client/src-tauri/python/runtime/Scripts/python.exe"), ["-Xutf8", "-c",
  "import json,sys;from media_image_layout import validate_layout\ndef check(v):\n try:return {'valid':True,'layout':validate_layout(v)}\n except (ValueError,TypeError):return {'valid':False}\nprint(json.dumps([check(v) for v in json.load(sys.stdin)],ensure_ascii=False))"],
  { input, encoding: "utf8", cwd: path.resolve("apps/client/src-tauri/python"), windowsHide: true });
assert.equal(python.status, 0, python.stderr);
const workers = JSON.parse(python.stdout);
const results = cases.map((test, index) => {
  const valid = api.mediaImageLayoutError(test.layout) === null;
  assert.equal(valid, test.valid, `TS: ${test.name}`);
  assert.equal(rust[index].valid, test.valid, `Rust: ${test.name}`);
  assert.equal(workers[index].valid, test.valid, `Python: ${test.name}`);
  if (valid) {
    assert.deepEqual(rust[index].layout, test.layout);
    assert.deepEqual(workers[index].layout, test.layout);
    assert.equal(rust[index].digest, api.mediaImageLayoutDigest(test.layout), `Digest: ${test.name}`);
  }
  return { name: test.name, valid, digest: rust[index].digest ?? null };
});
await writeFile(path.join(directory, "contract-parity.json"), JSON.stringify({ checkedAt: new Date().toISOString(), cases: results }, null, 2));
console.log(JSON.stringify({ cases: results.length, validators: ["TypeScript", "Rust", "Python"], digestAgreement: true }));
