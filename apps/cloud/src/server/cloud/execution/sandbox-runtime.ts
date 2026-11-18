import { isAbsolute } from "node:path";
import {
  detectSandboxArtifacts,
  hostSandboxBackend,
  pinSandboxArtifacts,
  SandboxArtifactError,
} from "@machdoch/cloud-client/sandbox-installation";
import type { RuntimeAsset } from "@machdoch/cloud-client/runtime-assets";
import {
  sandboxArtifactNames,
  type ExecutionSandbox,
  type SandboxArtifactName,
  type SandboxRuntimeInput,
} from "@machdoch/fleet-protocol/cloud-sandbox";
import type { CloudActor } from "../../../lib/cloud-contract";
import { CloudError, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";

export type HostedSandbox = { cgroupRoot: string | null } & Record<
  SandboxArtifactName,
  RuntimeAsset
>;

const artifactLabels: Record<SandboxArtifactName, string> = {
  supervisor: "Supervisor",
  qemu: "QEMU",
  kernel: "Kernel",
  initramfs: "Initramfs",
  image: "Image",
};

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

async function readStored(sql: CloudSql) {
  return (
    await sql.query<{ definition: HostedSandbox; saved_at: string }>(
      `SELECT definition,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS saved_at FROM cloud_sandbox_runtime WHERE id=1`,
    )
  ).rows[0];
}

export class CloudSandboxRuntime {
  constructor(private readonly database: CloudDatabase) {}

  async read(actor: CloudActor): Promise<ExecutionSandbox | null> {
    const stored = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      if (!(await servesInstallation(sql, actor.organizationId))) return null;
      return { row: await readStored(sql) };
    });
    if (!stored) return null;
    if (stored.row)
      return {
        backend: hostSandboxBackend,
        cgroupRoot: stored.row.definition.cgroupRoot,
        artifacts: Object.fromEntries(
          sandboxArtifactNames.map((name) => [
            name,
            stored.row!.definition[name].path,
          ]),
        ) as Record<SandboxArtifactName, string>,
        savedAt: stored.row.saved_at,
      };
    return {
      backend: hostSandboxBackend,
      cgroupRoot: null,
      artifacts: await detectSandboxArtifacts(),
      savedAt: null,
    };
  }

  async save(
    actor: CloudActor,
    input: SandboxRuntimeInput,
  ): Promise<ExecutionSandbox> {
    await this.database.transaction((sql) =>
      requireInstallationAdministrator(sql, actor),
    );
    const cgroupRoot = hostSandboxBackend === "kvm" ? input.cgroupRoot : null;
    if (hostSandboxBackend === "kvm" && !(cgroupRoot && isAbsolute(cgroupRoot)))
      throw new CloudError(
        400,
        "sandbox_cgroup",
        "Enter the absolute path of the delegated cgroup.",
      );
    let artifacts: Record<SandboxArtifactName, RuntimeAsset>;
    try {
      artifacts = await pinSandboxArtifacts(input.artifacts);
    } catch (error) {
      if (error instanceof SandboxArtifactError)
        throw new CloudError(
          400,
          "sandbox_artifact",
          `${artifactLabels[error.artifact]}: no file at this path.`,
        );
      throw error;
    }
    const definition: HostedSandbox = { cgroupRoot, ...artifacts };
    await this.database.transaction(async (sql) => {
      await requireInstallationAdministrator(sql, actor);
      await sql.query(
        "INSERT INTO cloud_sandbox_runtime (id,definition) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET definition=EXCLUDED.definition,updated_at=clock_timestamp()",
        [JSON.stringify(definition)],
      );
    });
    return (await this.read(actor))!;
  }

  async current(): Promise<HostedSandbox | null> {
    return this.database.transaction(
      async (sql) => (await readStored(sql))?.definition ?? null,
    );
  }
}
