import { stat } from "node:fs/promises";
import {
  locateHostSandbox,
  sandboxDirectory,
  type HostSandboxLocation,
} from "@machdoch/cloud-client/sandbox-installation";
import {
  fileDigest,
  type RuntimeAsset,
} from "@machdoch/cloud-client/runtime-assets";
import {
  sandboxArtifactNames,
  type ExecutionSandbox,
  type SandboxArtifactName,
} from "@machdoch/fleet-protocol/cloud-sandbox";
import type { CloudActor } from "../../../lib/cloud-contract";
import { CloudError, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";

export type HostedSandbox = { cgroupRoot: string | null } & Record<
  SandboxArtifactName,
  RuntimeAsset
>;

export async function servesInstallation(
  sql: CloudSql,
  organizationId: string,
): Promise<boolean> {
  return (
    (
      await sql.query(
        "SELECT 1 FROM cloud_installation WHERE id=1 AND organization_id=$1",
        [organizationId],
      )
    ).rows.length > 0
  );
}

export async function requireInstallationAdministrator(
  sql: CloudSql,
  actor: CloudActor,
): Promise<void> {
  await requireMembership(sql, actor, "ai.manage");
  if (!(await servesInstallation(sql, actor.organizationId)))
    throw new CloudError(
      403,
      "installation_required",
      "Only the organization that runs this server can use it for AI tasks.",
    );
}

export class CloudSandboxRuntime {
  private readonly digests = new Map<
    string,
    { size: number; modified: number; sha256: string }
  >();

  constructor(
    private readonly database: CloudDatabase,
    private readonly locate: () => Promise<HostSandboxLocation> = locateHostSandbox,
  ) {}

  async read(actor: CloudActor): Promise<ExecutionSandbox | null> {
    const served = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      return servesInstallation(sql, actor.organizationId);
    });
    if (!served) return null;
    return {
      directory: sandboxDirectory,
      missing: (await this.locate()).missing,
    };
  }

  async current(): Promise<HostedSandbox | null> {
    const location = await this.locate();
    if (location.missing.length) return null;
    const pinned = {} as Record<SandboxArtifactName, RuntimeAsset>;
    for (const name of sandboxArtifactNames)
      pinned[name] = await this.pin(location.artifacts[name]);
    return { cgroupRoot: location.cgroupRoot, ...pinned };
  }

  private async pin(path: string): Promise<RuntimeAsset> {
    const { size, mtimeMs } = await stat(path);
    const cached = this.digests.get(path);
    if (cached?.size === size && cached.modified === mtimeMs)
      return { path, sha256: cached.sha256 };
    const sha256 = await fileDigest(path);
    this.digests.set(path, { size, modified: mtimeMs, sha256 });
    return { path, sha256 };
  }
}
