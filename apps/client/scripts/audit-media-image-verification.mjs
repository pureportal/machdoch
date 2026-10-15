import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(process.argv[2]);
const evidenceRoots = [
  ...new Set([
    root,
    ...process.argv.slice(5).map((directory) => path.resolve(directory)),
  ]),
];
const destination = path.resolve(process.argv[3]);
assert.ok(process.argv[4], "Pass the current model store directory");
const database = new DatabaseSync(
  path.join(path.resolve(process.argv[4]), "media.sqlite3"),
  { readOnly: true },
);
database.exec("PRAGMA busy_timeout = 10000");
const installedModels = database
  .prepare(
    "SELECT m.id, m.architecture, m.display_name, m.capabilities_json, i.revision, i.bytes_on_disk " +
      "FROM media_models m JOIN media_model_installations i ON i.model_id = m.id " +
      "WHERE i.status = 'installed' AND m.target = 'local' " +
      "AND EXISTS (SELECT 1 FROM json_each(m.capabilities_json) WHERE value = 'text-to-image')",
  )
  .all();
database.close();
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const profiles = await readJson(
  "apps/client/src-tauri/python/image_sampling_profiles.json",
);
const original = await readJson(path.join(root, "engine-coverage-audit.json"));
const assessments = [];
for (const directory of evidenceRoots) {
  try {
    assessments.push(
      ...(await readJson(path.join(directory, "visual-assessments.json")))
        .assessments,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const assessmentByDigest = new Map(
  assessments.map((assessment) => [
    `${assessment.referenceId}:${assessment.sha256}`,
    assessment,
  ]),
);
const imageDigests = new Map();
const imageDigest = async (file) => {
  const resolved = path.resolve(file);
  if (!imageDigests.has(resolved)) {
    imageDigests.set(
      resolved,
      createHash("sha256")
        .update(await readFile(resolved))
        .digest("hex"),
    );
  }
  return imageDigests.get(resolved);
};
const workerBytes = await readFile(
  "apps/client/src-tauri/python/media_diffusers_worker.py",
);
const workerSha256 = createHash("sha256").update(workerBytes).digest("hex");
const records = [];
const seen = new Set();
for (const directory of evidenceRoots) {
  const files = await readdir(directory, { recursive: true });
  for (const file of files
    .filter((file) => path.basename(file) === "results.json")
    .sort()) {
    const summary = await readJson(path.join(directory, file));
    for (const model of summary.models ?? []) {
      if (!model.directory || seen.has(model.directory)) continue;
      seen.add(model.directory);
      records.push(model);
    }
  }
}
const installedArchitectures = new Map(
  installedModels.map((model) => [model.id, model.architecture]),
);
const accepted = [];
const excluded = [];
for (const record of records.filter(
  (record) => record.passed && record.image,
)) {
  const request = await readJson(path.join(record.directory, "request.json"));
  const response = await readJson(path.join(record.directory, "response.json"));
  const digest = await imageDigest(record.image);
  assert.equal(digest, record.sha256, record.directory);
  const referenceId = Number(
    record.referenceId ?? /reference-(\d+)/u.exec(record.directory)?.[1],
  );
  const assessment = assessmentByDigest.get(`${referenceId}:${digest}`);
  if (assessment) {
    const assessedDigest = await imageDigest(assessment.image);
    assert.equal(assessedDigest, digest, assessment.image);
  }
  const classificationChanged =
    installedArchitectures.get(record.id) !== record.architecture;
  const supersededKreaDefaults =
    record.architecture === "krea-2" &&
    request.sampling?.numInferenceSteps == null &&
    request.modelPolicy !== "fast" &&
    response.numInferenceSteps !== 12;
  if (classificationChanged || supersededKreaDefaults) {
    excluded.push({
      directory: record.directory,
      reason: classificationChanged
        ? "Superseded model classification"
        : "Superseded Krea default steps",
    });
    continue;
  }
  accepted.push(record);
}
const acceptedDirectories = new Set(accepted.map((record) => record.directory));
const coverage = profiles.map((profile) => {
  const previous = original.coverage.find(
    (entry) => entry.architecture === profile.architecture,
  ) ?? { architecture: profile.architecture };
  const realRuns = records
    .filter((record) => record.architecture === profile.architecture)
    .map((record) => {
      const referenceId = Number(
        record.referenceId ?? /reference-(\d+)/u.exec(record.directory)?.[1],
      );
      const assessment = assessmentByDigest.get(
        `${referenceId}:${record.sha256}`,
      );
      const validEvidence = acceptedDirectories.has(record.directory);
      return {
        ...record,
        referenceId: Number.isFinite(referenceId) ? referenceId : null,
        validEvidence,
        qualityVerdict: validEvidence
          ? (assessment?.referenceQualityVerdict ?? "not-assessed")
          : "not-assessed",
        observations: validEvidence ? (assessment?.observations ?? null) : null,
        currentClassification:
          installedArchitectures.get(record.id) === record.architecture,
      };
    });
  const referencesWithTechnicalPass = [
    ...new Set(
      realRuns
        .filter((record) => record.validEvidence && record.referenceId)
        .map((record) => record.referenceId),
    ),
  ];
  const referencesWithNearReferenceAesthetic = [
    ...new Set(
      realRuns
        .filter(
          (record) =>
            record.validEvidence &&
            record.referenceId &&
            record.qualityVerdict === "near-reference",
        )
        .map((record) => record.referenceId),
    ),
  ];
  return {
    ...previous,
    installedModels: installedModels
      .filter((model) => model.architecture === profile.architecture)
      .map((model) => ({
        id: model.id,
        name: model.display_name,
        revision: model.revision,
        bytesOnDisk: model.bytes_on_disk,
      })),
    installedCapabilities: [
      ...new Set(
        installedModels
          .filter((model) => model.architecture === profile.architecture)
          .flatMap((model) => JSON.parse(model.capabilities_json)),
      ),
    ],
    samplers: profile.samplers,
    settingsSources: profile.sources,
    realRuns,
    referencesWithTechnicalPass,
    referencesWithNearReferenceAesthetic,
    allSixReferenceQualityVerified: original.requiredReferences.every(
      (reference) => referencesWithNearReferenceAesthetic.includes(reference),
    ),
  };
});
const audit = {
  modelStoreDirectory: path.resolve(process.argv[4]),
  evidenceRoots,
  workerSha256,
  samplingArchitectures: profiles.length,
  requiredReferences: original.requiredReferences,
  coverage,
  overallComplete: coverage.every(
    (entry) => entry.allSixReferenceQualityVerified,
  ),
  qualityCriterion:
    "Inspected detail, style and aesthetic; documented composition differences remain",
  nativeValidationRecords: accepted.length,
  nativeValidationExcluded: excluded,
};
await mkdir(destination, { recursive: true });
await writeFile(
  path.join(root, "engine-coverage-audit-current.json"),
  JSON.stringify(audit, null, 2) + "\n",
);
await writeFile(
  path.join(destination, "engine-coverage-audit-current.json"),
  JSON.stringify(audit, null, 2) + "\n",
);
const validation = path.join(root, "native-response-validation-current");
await mkdir(validation, { recursive: true });
await writeFile(
  path.join(validation, "results.json"),
  JSON.stringify({ passed: true, models: accepted }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    architectures: profiles.length,
    installed: installedArchitectures.size,
    inspected: assessmentByDigest.size,
    nativeValidationRecords: accepted.length,
    excluded,
  }),
);
