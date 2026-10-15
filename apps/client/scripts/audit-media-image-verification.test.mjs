import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("./audit-media-image-verification.mjs", import.meta.url),
);
const workspace = fileURLToPath(new URL("../../../", import.meta.url));

async function prepareEvidence() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "machdoch-image-audit-"),
  );
  const primary = path.join(directory, "primary");
  const additional = path.join(directory, "additional");
  const destination = path.join(directory, "report");
  const store = path.join(directory, "store");
  await Promise.all(
    [primary, additional, store].map((folder) => mkdir(folder)),
  );
  const database = new DatabaseSync(path.join(store, "media.sqlite3"));
  database.exec(`
    CREATE TABLE media_models (id TEXT, architecture TEXT, display_name TEXT, capabilities_json TEXT, target TEXT);
    CREATE TABLE media_model_installations (model_id TEXT, status TEXT, revision TEXT, bytes_on_disk INTEGER);
    INSERT INTO media_models VALUES ('model', 'stable-diffusion-xl', 'SDXL', '["text-to-image"]', 'local');
    INSERT INTO media_model_installations VALUES ('model', 'installed', 'revision', 1);
  `);
  database.close();
  await writeFile(
    path.join(primary, "engine-coverage-audit.json"),
    JSON.stringify({
      requiredReferences: [144655944],
      coverage: [],
    }),
  );
  const image = path.join(additional, "output.png");
  const pixels = Buffer.from("verified generation artifact");
  await writeFile(image, pixels);
  const reviewedImage = path.join(additional, "reviewed-copy.png");
  await writeFile(reviewedImage, pixels);
  const sha256 = createHash("sha256").update(pixels).digest("hex");
  const record = {
    id: "model",
    architecture: "stable-diffusion-xl",
    referenceId: 144655944,
    directory: additional,
    image: reviewedImage,
    sha256,
    passed: true,
  };
  await writeFile(
    path.join(additional, "results.json"),
    JSON.stringify({ models: [record] }),
  );
  await writeFile(
    path.join(additional, "request.json"),
    JSON.stringify({ sampling: { numInferenceSteps: 30 } }),
  );
  await writeFile(
    path.join(additional, "response.json"),
    JSON.stringify({ numInferenceSteps: 30 }),
  );
  await writeFile(
    path.join(additional, "visual-assessments.json"),
    JSON.stringify({
      assessments: [
        {
          referenceId: 144655944,
          image,
          sha256,
          referenceQualityVerdict: "near-reference",
        },
      ],
    }),
  );
  return { directory, primary, additional, destination, store, image };
}

await test("audits renders and assessments from additional evidence directories once", async (context) => {
  const evidence = await prepareEvidence();
  context.after(() => rm(evidence.directory, { recursive: true, force: true }));
  await run(
    process.execPath,
    [
      script,
      evidence.primary,
      evidence.destination,
      evidence.store,
      evidence.additional,
      evidence.additional,
    ],
    { cwd: workspace },
  );
  const audit = JSON.parse(
    await readFile(
      path.join(evidence.destination, "engine-coverage-audit-current.json"),
      "utf8",
    ),
  );
  const sdxl = audit.coverage.find(
    (profile) => profile.architecture === "stable-diffusion-xl",
  );
  assert.equal(audit.nativeValidationRecords, 1);
  assert.equal(sdxl.realRuns.length, 1);
  assert.deepEqual(sdxl.referencesWithNearReferenceAesthetic, [144655944]);
  assert.equal(sdxl.allSixReferenceQualityVerified, true);
  assert.equal(audit.overallComplete, false);
});

await test("rejects modified images before counting their visual assessments", async (context) => {
  const evidence = await prepareEvidence();
  context.after(() => rm(evidence.directory, { recursive: true, force: true }));
  await writeFile(evidence.image, "modified artifact");
  await assert.rejects(
    run(
      process.execPath,
      [
        script,
        evidence.primary,
        evidence.destination,
        evidence.store,
        evidence.additional,
      ],
      { cwd: workspace },
    ),
    (error) => error.stderr.includes("AssertionError"),
  );
});

await test("does not apply an image assessment to a different reference", async (context) => {
  const evidence = await prepareEvidence();
  context.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const assessmentPath = path.join(
    evidence.additional,
    "visual-assessments.json",
  );
  const document = JSON.parse(await readFile(assessmentPath, "utf8"));
  document.assessments[0].referenceId = 144697438;
  await writeFile(assessmentPath, JSON.stringify(document));
  await run(
    process.execPath,
    [
      script,
      evidence.primary,
      evidence.destination,
      evidence.store,
      evidence.additional,
    ],
    { cwd: workspace },
  );
  const audit = JSON.parse(
    await readFile(
      path.join(evidence.destination, "engine-coverage-audit-current.json"),
      "utf8",
    ),
  );
  const sdxl = audit.coverage.find(
    (profile) => profile.architecture === "stable-diffusion-xl",
  );
  assert.equal(audit.nativeValidationRecords, 1);
  assert.deepEqual(sdxl.referencesWithNearReferenceAesthetic, []);
  assert.equal(sdxl.realRuns[0].qualityVerdict, "not-assessed");
});

await test("excluded Krea defaults cannot satisfy technical or quality coverage", async (context) => {
  const evidence = await prepareEvidence();
  context.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const database = new DatabaseSync(path.join(evidence.store, "media.sqlite3"));
  database.exec("UPDATE media_models SET architecture = 'krea-2'");
  database.close();
  const resultsPath = path.join(evidence.additional, "results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  results.models[0].architecture = "krea-2";
  await writeFile(resultsPath, JSON.stringify(results));
  await writeFile(
    path.join(evidence.additional, "request.json"),
    JSON.stringify({ modelPolicy: "quality", sampling: {} }),
  );
  await run(
    process.execPath,
    [
      script,
      evidence.primary,
      evidence.destination,
      evidence.store,
      evidence.additional,
    ],
    { cwd: workspace },
  );
  const audit = JSON.parse(
    await readFile(
      path.join(evidence.destination, "engine-coverage-audit-current.json"),
      "utf8",
    ),
  );
  const krea = audit.coverage.find(
    (profile) => profile.architecture === "krea-2",
  );
  assert.equal(audit.nativeValidationRecords, 0);
  assert.equal(
    audit.nativeValidationExcluded[0].reason,
    "Superseded Krea default steps",
  );
  assert.deepEqual(krea.referencesWithTechnicalPass, []);
  assert.deepEqual(krea.referencesWithNearReferenceAesthetic, []);
  assert.equal(krea.allSixReferenceQualityVerified, false);
  assert.equal(krea.realRuns[0].validEvidence, false);
  assert.equal(krea.realRuns[0].qualityVerdict, "not-assessed");
});

await test("a passed record without a verified artifact cannot satisfy coverage", async (context) => {
  const evidence = await prepareEvidence();
  context.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const resultsPath = path.join(evidence.additional, "results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  delete results.models[0].image;
  await writeFile(resultsPath, JSON.stringify(results));
  await run(
    process.execPath,
    [
      script,
      evidence.primary,
      evidence.destination,
      evidence.store,
      evidence.additional,
    ],
    { cwd: workspace },
  );
  const audit = JSON.parse(
    await readFile(
      path.join(evidence.destination, "engine-coverage-audit-current.json"),
      "utf8",
    ),
  );
  const sdxl = audit.coverage.find(
    (profile) => profile.architecture === "stable-diffusion-xl",
  );
  assert.equal(audit.nativeValidationRecords, 0);
  assert.deepEqual(sdxl.referencesWithTechnicalPass, []);
  assert.deepEqual(sdxl.referencesWithNearReferenceAesthetic, []);
  assert.equal(sdxl.allSixReferenceQualityVerified, false);
});
