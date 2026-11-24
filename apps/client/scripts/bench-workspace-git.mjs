import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_VERSION = "v1";
const LARGE_TRACKED_FILES = 50_000;
const LARGE_UNTRACKED_FILES = 2_000;
const LARGE_MODIFIED_FILES = 25;
const BRANCH_COUNT = 1_000;
const BRANCH_COMMITS = 20_000;
const NESTED_REPOSITORIES = 6;
const NESTED_FILES = 2_000;

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(clientRoot, "../..");
const specPath = join(
  repositoryRoot,
  ".machdoch/local/goals/client-workspace-tools-spec.md",
);

const parseArguments = (argv) => {
  const options = {
    column: null,
    samples: 15,
    fixtures: join(tmpdir(), `machdoch-git-bench-${FIXTURE_VERSION}`),
    reference: "C:\\Development\\alphartis.annie",
    output: null,
    fixturesOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} needs a value.`);
      return next;
    };
    if (argument === "--record") {
      const column = value();
      if (column !== "baseline" && column !== "after")
        throw new Error("--record accepts baseline or after.");
      options.column = column;
    } else if (argument === "--samples") options.samples = Number(value());
    else if (argument === "--fixtures") options.fixtures = resolve(value());
    else if (argument === "--reference") options.reference = value();
    else if (argument === "--no-reference") options.reference = null;
    else if (argument === "--output") options.output = resolve(value());
    else if (argument === "--fixtures-only") options.fixturesOnly = true;
    else throw new Error(`Unknown argument ${argument}.`);
  }
  if (!Number.isInteger(options.samples) || options.samples < 3)
    throw new Error("--samples must be an integer of at least 3.");
  return options;
};

const git = (cwd, args, input) =>
  execFileSync("git", args, {
    cwd,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  }).toString();

const initRepository = (path) => {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--quiet", "-b", "main"]);
  git(path, ["config", "user.email", "bench@example.test"]);
  git(path, ["config", "user.name", "Bench"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["config", "core.autocrlf", "false"]);
};

const blob = (content) => {
  const bytes = Buffer.from(content);
  return `data ${bytes.length}\n${content}\n`;
};

const fastImport = (path, stream) =>
  git(path, ["fast-import", "--quiet", "--done"], `${stream}done\n`);

const timestamp = (offset) => `${1_700_000_000 + offset} +0000`;

const trackedFilePath = (index) =>
  `src/module-${String(Math.floor(index / 500)).padStart(3, "0")}/file-${String(index).padStart(5, "0")}.ts`;

const createLargeRepository = (path) => {
  initRepository(path);
  const parts = [
    `commit refs/heads/main\ncommitter Bench <bench@example.test> ${timestamp(0)}\n${blob("Initial large tree")}`,
  ];
  for (let index = 0; index < LARGE_TRACKED_FILES; index += 1)
    parts.push(
      `M 100644 inline ${trackedFilePath(index)}\n${blob(`export const value${index} = ${index};\n`)}`,
    );
  parts.push("\n");
  fastImport(path, parts.join(""));
  git(path, ["reset", "--quiet", "--hard", "main"]);
  writeFileSync(join(path, ".gitignore"), "ignored/\n");
  git(path, ["add", ".gitignore"]);
  git(path, ["commit", "--quiet", "-m", "Ignore rules"]);
  for (let index = 0; index < LARGE_MODIFIED_FILES; index += 1) {
    const file = join(path, trackedFilePath(index * 97));
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}export const edited = true;\n`,
    );
  }
  for (let index = 0; index < LARGE_UNTRACKED_FILES; index += 1) {
    const directory = join(
      path,
      "generated",
      `batch-${Math.floor(index / 200)}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `untracked-${index}.txt`),
      `untracked ${index}\n`,
    );
  }
  return { changedFile: trackedFilePath(0) };
};

const createBranchRepository = (path) => {
  initRepository(path);
  const parts = [];
  for (let index = 0; index < BRANCH_COMMITS; index += 1) {
    parts.push(
      `commit refs/heads/main\nmark :${index + 1}\ncommitter Bench <bench@example.test> ${timestamp(index * 60)}\n${blob(`Commit ${index}`)}`,
    );
    if (index > 0) parts.push(`from :${index}\n`);
    parts.push(
      `M 100644 inline history/file-${index % 200}.txt\n${blob(`revision ${index}\n`)}\n`,
    );
  }
  for (let index = 0; index < BRANCH_COUNT; index += 1) {
    const mark = BRANCH_COMMITS - 1 - ((index * 17) % 2_000);
    const name = `cloud-${String(1000 + index)}-feature-${index}`;
    parts.push(`reset refs/heads/${name}\nfrom :${mark}\n\n`);
    parts.push(
      `reset refs/remotes/origin/${name}\nfrom :${Math.max(1, mark - (index % 5))}\n\n`,
    );
  }
  parts.push(`reset refs/remotes/origin/main\nfrom :${BRANCH_COMMITS - 3}\n\n`);
  fastImport(path, parts.join(""));
  const config = [
    '[remote "origin"]',
    "\turl = https://example.test/bench.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
  ];
  for (let index = 0; index < BRANCH_COUNT; index += 1) {
    const name = `cloud-${String(1000 + index)}-feature-${index}`;
    config.push(
      `[branch "${name}"]`,
      "\tremote = origin",
      `\tmerge = refs/heads/${name}`,
    );
  }
  writeFileSync(
    join(path, ".git", "config"),
    `${readFileSync(join(path, ".git", "config"), "utf8")}${config.join("\n")}\n`,
  );
  git(path, ["reset", "--quiet", "--hard", "main"]);
};

const createNestedWorkspace = (path) => {
  initRepository(path);
  const children = Array.from(
    { length: NESTED_REPOSITORIES - 1 },
    (_, index) => `services/service-${index + 1}`,
  );
  writeFileSync(join(path, ".gitignore"), "services/\n");
  writeFileSync(join(path, "README.md"), "Workspace\n");
  git(path, ["add", "."]);
  git(path, ["commit", "--quiet", "-m", "Workspace"]);
  for (const child of children) {
    const childPath = join(path, child);
    initRepository(childPath);
    const parts = [
      `commit refs/heads/main\ncommitter Bench <bench@example.test> ${timestamp(0)}\n${blob(`Initial ${child}`)}`,
    ];
    for (let index = 0; index < NESTED_FILES; index += 1)
      parts.push(
        `M 100644 inline src/part-${Math.floor(index / 100)}/file-${index}.ts\n${blob(`export const item${index} = ${index};\n`)}`,
      );
    parts.push("\n");
    fastImport(childPath, parts.join(""));
    git(childPath, ["reset", "--quiet", "--hard", "main"]);
    writeFileSync(
      join(childPath, "src/part-0/file-0.ts"),
      "export const changed = true;\n",
    );
    writeFileSync(join(childPath, "notes.md"), "untracked\n");
  }
};

const ensureFixtures = (root) => {
  const marker = join(root, "fixtures.json");
  if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf8"));
  mkdirSync(root, { recursive: true });
  console.log("Generating the large repository fixture…");
  const large = createLargeRepository(join(root, "large"));
  console.log("Generating the branch fixture…");
  createBranchRepository(join(root, "branches"));
  console.log("Generating the nested workspace fixture…");
  createNestedWorkspace(join(root, "nested"));
  const fixtures = {
    largeRepository: join(root, "large"),
    largeRepositoryChangedFile: large.changedFile,
    branchRepository: join(root, "branches"),
    multiRepositoryWorkspace: join(root, "nested"),
  };
  writeFileSync(marker, JSON.stringify(fixtures, null, 2));
  return fixtures;
};

const runRustBenchmark = (test, environment, output) => {
  const result = spawnSync(
    process.execPath,
    [
      join(clientRoot, "scripts/run-cargo.mjs"),
      "test",
      "--lib",
      test,
      "--",
      "--ignored",
      "--exact",
      "--nocapture",
    ],
    {
      cwd: join(clientRoot, "src-tauri"),
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ...environment },
    },
  );
  if (result.status !== 0) throw new Error(`The benchmark ${test} failed.`);
  return JSON.parse(readFileSync(output, "utf8"));
};

const BASELINE_ROWS = [
  ["summary badge", "large repo", "summary", "large repo", "warm"],
  ["overview", "large repo", "overview", "large repo", "warm"],
  ["repositories status", "6 repos", "repositories status", "6 repos", "warm"],
  [
    "branch picker open",
    "1k branches",
    "branch picker open",
    "1k branches",
    "warm",
  ],
  ["single-file diff", "large repo", "single-file diff", "large repo", "warm"],
  [
    "stage → UI updated",
    "large repo",
    "stage → UI updated",
    "large repo",
    "warm",
  ],
  ["quick open (files)", "50k files", "quick open", "large repo", "warm"],
  ["terminal 50 MB output", "—", "terminal 50 MB output", "—", "warm"],
  ["overview", "alphartis.annie", "overview", "alphartis.annie", "warm"],
];

const AFTER_ROWS = [
  ["summary badge", "large repo", "summary after edit", "large repo", "warm"],
  ["overview", "large repo", "overview after edit", "large repo", "warm"],
  [
    "repositories status",
    "6 repos",
    "repositories status after edit",
    "6 repos",
    "warm",
  ],
  [
    "branch picker open",
    "1k branches",
    "branch picker open",
    "1k branches",
    "warm",
  ],
  [
    "single-file diff",
    "large repo",
    "single-file diff after edit",
    "large repo",
    "warm",
  ],
  [
    "stage → UI updated",
    "large repo",
    "stage → UI updated",
    "large repo",
    "warm",
  ],
  ["quick open (files)", "50k files", "quick open", "large repo", "warm"],
  ["terminal 50 MB output", "—", "terminal 50 MB output", "—", "warm"],
  ["overview", "alphartis.annie", "overview", "alphartis.annie", "cold"],
];

const format = (measurement) =>
  measurement
    ? `${measurement.p50.toFixed(1)} / ${measurement.p95.toFixed(1)} ms`
    : "";

const writeResults = (column, measurements) => {
  const spec = readFileSync(specPath, "utf8");
  const lines = spec.split(/\r?\n/u);
  const updated = lines.map((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 7) return line;
    const rows = column === "baseline" ? BASELINE_ROWS : AFTER_ROWS;
    const row = rows.find(
      ([label, fixture]) => cells[1] === label && cells[2] === fixture,
    );
    if (!row) return line;
    const measurement = measurements.find(
      (entry) =>
        entry.name === row[2] &&
        entry.fixture === row[3] &&
        entry.temperature === row[4],
    );
    if (!measurement) return line;
    cells[column === "baseline" ? 3 : 4] = format(measurement);
    return `| ${cells.slice(1, 6).join(" | ")} |`;
  });
  writeFileSync(specPath, updated.join("\n"));
};

const options = parseArguments(process.argv.slice(2));
const fixtures = ensureFixtures(options.fixtures);
if (options.fixturesOnly) process.exit(0);
const description = join(options.fixtures, "run.json");
writeFileSync(
  description,
  JSON.stringify({
    ...fixtures,
    referenceWorkspace:
      options.reference && existsSync(options.reference)
        ? options.reference
        : null,
    samples: options.samples,
  }),
);
const output = options.output ?? join(options.fixtures, "results.json");
const gitOutput = join(options.fixtures, "git-results.json");
const terminalOutput = join(options.fixtures, "terminal-results.json");
const measurements = [
  ...runRustBenchmark(
    "workspace_git::bench::workspace_git_benchmark",
    {
      MACHDOCH_GIT_BENCH_FIXTURES: description,
      MACHDOCH_GIT_BENCH_OUTPUT: gitOutput,
    },
    gitOutput,
  ),
  ...runRustBenchmark(
    "workspace_tools::terminal::bench::workspace_terminal_benchmark",
    { MACHDOCH_TERMINAL_BENCH_OUTPUT: terminalOutput },
    terminalOutput,
  ),
];
writeFileSync(output, JSON.stringify(measurements, null, 2));
for (const entry of measurements)
  console.log(
    `${entry.name.padEnd(28)} ${entry.fixture.padEnd(16)} ${entry.temperature.padEnd(5)} p50 ${entry.p50.toFixed(1).padStart(8)} ms  p95 ${entry.p95.toFixed(1).padStart(8)} ms`,
  );
if (options.column) writeResults(options.column, measurements);
