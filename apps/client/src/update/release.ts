import { gt, valid } from "semver";

export const RELEASE_REPOSITORY = "pureportal/machdoch";
export const RELEASE_MANIFEST_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`;

export interface UpdateArtifact {
  url: string;
  signature: string;
  sha256: string;
  size: number;
}

export interface UpdateRelease {
  version: string;
  notes: string;
  platforms: Record<string, UpdateArtifact>;
}

export function validateArtifactUrl(value: string, version: string): URL {
  const url = new URL(value);
  const prefix = `/pureportal/machdoch/releases/download/v${version}/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    !/^machdoch-[a-zA-Z0-9._-]+$/.test(url.pathname.slice(prefix.length))
  )
    throw new Error("The update contains an invalid download URL.");
  return url;
}

export function parseRelease(value: unknown): UpdateRelease {
  if (!value || typeof value !== "object")
    throw new Error("Invalid update manifest.");
  const manifest = value as Record<string, unknown>;
  const version =
    typeof manifest.version === "string" ? valid(manifest.version) : null;
  if (
    !version ||
    version.includes("-") ||
    !manifest.platforms ||
    typeof manifest.platforms !== "object"
  ) {
    throw new Error(
      "The update manifest must contain a stable release version and platforms.",
    );
  }
  const platforms: Record<string, UpdateArtifact> = Object.create(null);
  for (const [target, item] of Object.entries(manifest.platforms)) {
    if (!item || typeof item !== "object")
      throw new Error(`Invalid update artifact: ${target}`);
    const artifact = item as Record<string, unknown>;
    if (
      typeof artifact.url !== "string" ||
      typeof artifact.signature !== "string" ||
      !artifact.signature ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      artifact.size > 4 * 1024 ** 3
    )
      throw new Error(`Invalid update artifact: ${target}`);
    validateArtifactUrl(artifact.url, version);
    platforms[target] = artifact as unknown as UpdateArtifact;
  }
  return {
    version,
    notes: typeof manifest.notes === "string" ? manifest.notes : "",
    platforms,
  };
}

export async function checkLatestRelease(
  currentVersion: string,
): Promise<UpdateRelease | null> {
  if (!valid(currentVersion))
    throw new Error("The installed version is invalid.");
  const response = await fetch(RELEASE_MANIFEST_URL, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": `Machdoch/${currentVersion}`,
      "Cache-Control": "no-cache",
    },
  });
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        "The latest release has no signed updates. Try again after the next release.",
      );
    throw new Error(
      `Checking for updates failed (HTTP ${response.status}). Try again later.`,
    );
  }
  if (!response.body) throw new Error("The update manifest is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw new Error("The update manifest is too large.");
    chunks.push(chunk);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const body = new TextDecoder().decode(combined);
  const release = parseRelease(JSON.parse(body));
  return gt(release.version, currentVersion) ? release : null;
}
