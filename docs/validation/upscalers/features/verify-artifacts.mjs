import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("docs/validation/upscalers/features");
const reports = await Promise.all(
  ["playwright-results.json", "final-ui-results.json"].map(async (name) =>
    JSON.parse(await readFile(path.join(directory, name), "utf8")),
  ),
);
const roots = [
  ".cache/upscale-features-native",
  ".cache/upscale-features-final",
];
const records = await Promise.all(
  roots.map(async (root, index) => {
    assert.equal(reports[index].completed, true);
    const executable = createHash("sha256")
      .update(await readFile(path.join(root, "machdoch.exe")))
      .digest("hex");
    assert.equal(executable, reports[index].executableSha256);
    const workers = await Promise.all(
      ["media_upscale.py", "media_upscale_settings.py"].map(async (name) => {
        const [source, deployed] = await Promise.all([
          readFile(path.join("apps/client/src-tauri/python", name)),
          readFile(path.join(root, "python", name)),
        ]);
        assert.deepEqual(source, deployed);
        return {
          name,
          sha256: createHash("sha256").update(deployed).digest("hex"),
          matchesSource: true,
        };
      }),
    );
    return { root, executableSha256: executable, workers };
  }),
);
await writeFile(
  path.join(directory, "artifacts.json"),
  JSON.stringify(records, null, 2),
);
console.log(
  "Both desktop artifacts and their upscale workers match the validation reports and current Python sources.",
);
