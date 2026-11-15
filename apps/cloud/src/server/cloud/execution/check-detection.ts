import type { ExecutionCheck } from "@machdoch/fleet-protocol/cloud-execution";

export type RepositoryFileReader = (path: string) => Promise<string | null>;

const nodeScripts = [
  ["typecheck", "Type check"],
  ["lint", "Lint"],
  ["test", "Tests"],
  ["build", "Build"],
] as const;

function check(name: string, command: string): ExecutionCheck {
  return { name, command, timeoutSeconds: 300 };
}

async function nodeChecks(
  read: RepositoryFileReader,
): Promise<ExecutionCheck[]> {
  const manifest = await read("package.json");
  if (!manifest) return [];
  let scripts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifest);
    scripts =
      parsed &&
      typeof parsed === "object" &&
      "scripts" in parsed &&
      parsed.scripts &&
      typeof parsed.scripts === "object"
        ? (parsed.scripts as Record<string, unknown>)
        : {};
  } catch {
    return [];
  }
  const manager = (await read("pnpm-lock.yaml"))
    ? "pnpm"
    : (await read("yarn.lock"))
      ? "yarn"
      : (await read("bun.lock"))
        ? "bun"
        : "npm";
  return nodeScripts
    .filter(
      ([script]) =>
        typeof scripts[script] === "string" &&
        !/no test specified/i.test(scripts[script] as string),
    )
    .map(([script, name]) => check(name, `${manager} run ${script}`));
}

export async function detectRepositoryChecks(
  read: RepositoryFileReader,
): Promise<ExecutionCheck[]> {
  const node = await nodeChecks(read);
  if (node.length) return node;
  if (await read("go.mod"))
    return [check("Vet", "go vet ./..."), check("Tests", "go test ./...")];
  if (await read("Cargo.toml")) return [check("Tests", "cargo test --offline")];
  const pyproject = await read("pyproject.toml");
  if (pyproject || (await read("pytest.ini")))
    return [check("Tests", "python -m pytest -q")];
  const makefile = await read("Makefile");
  if (makefile && /^test\s*:/m.test(makefile))
    return [check("Tests", "make test")];
  return [];
}
