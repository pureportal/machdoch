import type { DeliveryGate } from "@machdoch/fleet-protocol/cloud-delivery";
import type { DiffFile } from "./unified-diff";

const maximumChangedLines = 1500;
const maximumChangedFiles = 40;

const testPath =
  /(^|\/)(__tests__|__snapshots__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb|exs)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$/i;
const disabledTest =
  /\b(describe|it|test|context)\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|@(Disabled|Ignore)\b|@pytest\.mark\.(skip|xfail)\b|\bt\.Skip(Now|f)?\s*\(|\bunittest\.skip\b|\[(Ignore|Skip)[\]("]/;
const checkConfiguration =
  /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)(jest|vitest|playwright|karma|cypress)\.config\.[a-z]+$|(^|\/)(pytest|tox|setup)\.(ini|cfg)$|(^|\/)codecov\.ya?ml$/i;
const protectedPath =
  /(^|\/)(auth|authentication|authorization|security|secrets?|credentials?|billing|payments?|crypto)(\/|\.|_|-)|(^|\/)(migrations?|db\/migrate)\/|\.sql$|(^|\/)(terraform|infra|infrastructure|deploy|helm|k8s|kubernetes)\/|\.tf$|(^|\/)\.env($|\.)|(^|\/)CODEOWNERS$/i;

function gate(
  id: DeliveryGate["id"],
  paths: string[],
  passed: string,
  failed: string,
): DeliveryGate {
  return {
    id,
    passed: paths.length === 0,
    detail: paths.length ? failed : passed,
    paths: paths.slice(0, 20),
  };
}

export function deliveryGates(
  files: DiffFile[],
  checks: { name: string; passed: boolean }[],
): DeliveryGate[] {
  const weakenedTests = new Set<string>();
  for (const file of files) {
    if (file.status === "deleted" && testPath.test(file.path))
      weakenedTests.add(file.path);
    if (checkConfiguration.test(file.path)) weakenedTests.add(file.path);
    if (
      testPath.test(file.path) &&
      file.hunks.some((hunk) =>
        hunk.lines.some(
          (line) => line.kind === "addition" && disabledTest.test(line.text),
        ),
      )
    )
      weakenedTests.add(file.path);
  }
  const lines = files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  const failedChecks = checks.filter((check) => !check.passed);
  return [
    {
      id: "checks",
      passed: checks.length > 0 && failedChecks.length === 0,
      detail: !checks.length
        ? "No automated checks are configured."
        : failedChecks.length
          ? `Failed: ${failedChecks.map((check) => check.name).join(", ")}.`
          : `Passed: ${checks.map((check) => check.name).join(", ")}.`,
      paths: [],
    },
    gate(
      "tests_intact",
      [...weakenedTests],
      "No tests were removed, skipped or reconfigured.",
      "Tests were removed, skipped or their configuration changed.",
    ),
    gate(
      "protected_paths",
      files
        .flatMap((file) => [file.path, file.previousPath ?? ""])
        .filter((path) => path && protectedPath.test(path)),
      "No sensitive areas were changed.",
      "Sensitive areas changed: security, billing, migrations, infrastructure or secrets.",
    ),
    {
      id: "change_size",
      passed:
        lines <= maximumChangedLines && files.length <= maximumChangedFiles,
      detail: `${files.length} ${files.length === 1 ? "file" : "files"}, ${lines.toLocaleString("en-US")} changed lines${
        lines <= maximumChangedLines && files.length <= maximumChangedFiles
          ? "."
          : `; automatic merging allows up to ${maximumChangedFiles} files and ${maximumChangedLines.toLocaleString("en-US")} lines.`
      }`,
      paths: [],
    },
  ];
}
