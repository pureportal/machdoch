export function parseSignedArtifactMetadata(encoded: string): {
  version: string;
  fileName: string;
} {
  let lines: string[];
  try {
    lines = atob(encoded.trim()).trim().split(/\r?\n/);
  } catch {
    throw new Error("Invalid update signature encoding.");
  }
  if (lines.length !== 4 || !lines[2]?.startsWith("trusted comment: "))
    throw new Error("Invalid update signature format.");
  const fields = lines[2].slice("trusted comment: ".length).split("\t");
  const versions = fields.filter((field) => field.startsWith("version:"));
  const names = fields.filter((field) => field.startsWith("file:"));
  if (
    versions.length !== 1 ||
    names.length !== 1 ||
    !versions[0]!.slice(8) ||
    !names[0]!.slice(5)
  )
    throw new Error(
      "The update signature must identify one version and filename.",
    );
  return { version: versions[0]!.slice(8), fileName: names[0]!.slice(5) };
}
