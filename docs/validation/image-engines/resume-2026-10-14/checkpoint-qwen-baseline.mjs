import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve(
  "docs/validation/image-engines/resume-2026-10-14",
);
const owner = JSON.parse(
  (
    await readFile(
      path.join(evidence, "qwen-reference-worker-owner.json"),
      "utf8",
    )
  ).replace(/^\uFEFF/u, ""),
);
assert.equal(owner.pid, 20224);
assert.ok(Number.isSafeInteger(owner.creationTimeMilliseconds));
const directory = path.resolve(
  "D:/Models/machdoch/verification/2026-10-13/image-engines/qwen-image/01-qwen-image-reference-144655944",
);
const results = path.join(path.dirname(directory), "results.json");
let lastUpdate = 0;
for (;;) {
  const summary = JSON.parse(await readFile(results, "utf8"));
  const record = summary.models.find(
    (item) =>
      path.resolve(item.directory) === directory &&
      item.workerSha256 ===
        "0eff19924639f152f23be910deefea81e25863235b0be10d5c1a0a2b2c9705a4",
  );
  assert.ok(record, "The owned Qwen baseline record is missing");
  assert.equal(record.referenceId, 144655944);
  if (record.passed || record.error) {
    if (record.passed) {
      const image = path.resolve(record.image);
      assert.equal(path.dirname(image), path.join(directory, "images"));
      assert.equal(
        createHash("sha256")
          .update(await readFile(image))
          .digest("hex"),
        record.sha256,
      );
    }
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const command = [
      `$target = Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}'`,
      "if ($null -eq $target) { throw 'The owned reference worker is missing.' }",
      `if ($target.ExecutablePath -ne ${quote(owner.executable)}) { throw 'The PID belongs to a different executable.' }`,
      `if (([DateTimeOffset]$target.CreationDate).ToUnixTimeMilliseconds() -ne ${owner.creationTimeMilliseconds}) { throw 'The reference worker PID has been reused.' }`,
      `if (-not $target.CommandLine.Contains(${quote(owner.script)}) -or -not $target.CommandLine.Contains(${quote(owner.manifest)})) { throw 'The PID belongs to a different task.' }`,
      `Stop-Process -Id ${owner.pid} -ErrorAction Stop`,
    ].join("\n");
    await new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Checkpoint stop failed: ${code}`)),
      );
    });
    const checkpoint = {
      stoppedOwnedWorker: true,
      pid: owner.pid,
      imageCompleted: record.passed,
      case: record,
      batchCompleted: false,
      reason:
        "Review the first Qwen baseline and run shorter quality comparisons before continuing the larger batches.",
      stoppedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(evidence, "qwen-baseline-checkpoint.json"),
      JSON.stringify(checkpoint, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        checkpoint: true,
        imageCompleted: record.passed,
        image: record.image,
        error: record.error,
      }),
    );
    break;
  }
  if (Date.now() - lastUpdate >= 60_000) {
    console.log(
      JSON.stringify({
        waitingForBaseline: true,
        pid: owner.pid,
        referenceId: record.referenceId,
      }),
    );
    lastUpdate = Date.now();
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
