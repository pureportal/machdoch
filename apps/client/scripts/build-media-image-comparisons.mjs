import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);
const cases = JSON.parse(
  await readFile(
    path.join(root, "six-reference-generation-cases.json"),
    "utf8",
  ),
);
const files = await readdir(root, { recursive: true });
const assessments = JSON.parse(
  await readFile(path.join(root, "visual-assessments.json"), "utf8"),
).assessments;
await mkdir(destination, { recursive: true });
const references = {};
for (const entry of cases) {
  const image = files.find((file) =>
    path.basename(file).startsWith(`reference-${entry.id}-image.`),
  );
  assert.ok(image, `Missing reference image ${entry.id}`);
  const filename = path.basename(image);
  await copyFile(path.join(root, image), path.join(destination, filename));
  references[String(entry.id)] = {
    image: filename,
    url: `https://civitai.red/images/${entry.id}`,
  };
}
const generations = [];
const seen = new Set();
for (const file of files
  .filter((file) => path.basename(file) === "results.json")
  .sort()) {
  const summary = JSON.parse(await readFile(path.join(root, file), "utf8"));
  for (const record of summary.models ?? []) {
    if (!record.passed || !record.directory || !record.image) continue;
    const referenceId = String(
      record.referenceId ??
        /reference-(\d+)/u.exec(record.directory)?.[1] ??
        "",
    );
    const reference = cases.find((entry) => String(entry.id) === referenceId);
    if (!reference) continue;
    const bytes = await readFile(record.image);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      record.sha256,
      sha256,
      `Image digest mismatch: ${record.directory}`,
    );
    const assessment = assessments.find((entry) => entry.sha256 === sha256);
    if (assessment?.displayInComparison === false) continue;
    const key = `${referenceId}:${record.id}:${sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const request = JSON.parse(
      await readFile(path.join(record.directory, "request.json"), "utf8"),
    );
    const response = JSON.parse(
      await readFile(path.join(record.directory, "response.json"), "utf8"),
    );
    const original = (await readFile(reference.promptFile, "utf8")).trim();
    const image = `${record.architecture}-${sha256.slice(0, 16)}.png`;
    await copyFile(record.image, path.join(destination, image));
    generations.push({
      referenceId,
      engine: record.architecture,
      model: record.name,
      image,
      width: record.width,
      height: record.height,
      steps: response.numInferenceSteps,
      sampler: response.sampler ?? "Automatic",
      requestedGuidance: request.sampling?.guidanceScale ?? null,
      seed: request.seed,
      sha256,
      seconds: record.seconds,
      workerVersion: response.workerVersion,
      observations: assessment?.observations ?? null,
      addons: request.addons?.length ?? 0,
      promptSource:
        request.prompt.trim() === original
          ? reference.originalPrompt
            ? "Source prompt"
            : "Observed description"
          : "Adapted prompt",
    });
  }
}
generations.sort(
  (left, right) =>
    Number(left.referenceId) - Number(right.referenceId) ||
    left.model.localeCompare(right.model),
);
const data = { references, generations };
await writeFile(
  path.join(destination, "manifest.json"),
  JSON.stringify(data, null, 2) + "\n",
);
const template = await readFile(path.join(destination, "index.html"), "utf8");
const manifestPattern = /const data=\{.*\};\r?\n/u;
assert.match(
  template,
  manifestPattern,
  "The comparison template is missing its manifest",
);
const updated = template.replace(
  manifestPattern,
  `const data=${JSON.stringify(data).replaceAll("<", "\\u003c")};\n`,
);
await writeFile(path.join(destination, "index.html"), updated);
console.log(
  JSON.stringify({
    references: cases.length,
    renders: generations.length,
    destination,
  }),
);
