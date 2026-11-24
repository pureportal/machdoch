import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  maximumMcpConnectors,
  type AgentMcpConnector,
  type AgentPersonalization,
  type McpConnectorInput,
} from "../../../lib/agent-personalization";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, command, requireMembership } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { sameRepository } from "../git/repository-access";
import {
  AgentConnectorTools,
  type McpConnect,
  type McpConnectorTarget,
} from "./agent-connectors";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function tokenContext(actor: CloudActor, connectorId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: "cloud.agent.mcp-connector",
      organizationId: actor.organizationId,
      userId: actor.userId,
      connectorId,
    }),
  );
}

export interface AgentRepositoryScope {
  allows(url: string): boolean;
  allowsId(repositoryId: string): boolean;
}

const unrestricted: AgentRepositoryScope = {
  allows: () => true,
  allowsId: () => true,
};

export async function agentRepositoryScope(
  sql: CloudSql,
  actor: CloudActor,
): Promise<AgentRepositoryScope> {
  const allowed = (
    await sql.query<{ id: string; webUrl: string | null }>(
      `SELECT r.id,r.web_url AS "webUrl" FROM cloud_agent_allowed_repositories a
      JOIN cloud_git_repositories r ON r.organization_id=a.organization_id AND r.id=a.repository_id
      WHERE a.organization_id=$1 AND a.user_id=$2`,
      [actor.organizationId, actor.userId],
    )
  ).rows;
  if (!allowed.length) return unrestricted;
  const ids = new Set(allowed.map((entry) => entry.id));
  return {
    allows: (url) =>
      allowed.some(
        (entry) => entry.webUrl !== null && sameRepository(entry.webUrl, url),
      ),
    allowsId: (repositoryId) => ids.has(repositoryId),
  };
}

export class CloudAgentPersonalization {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly connect: McpConnect,
  ) {}

  get(actor: CloudActor): Promise<AgentPersonalization> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const connectors = await sql.query<AgentMcpConnector>(
        `SELECT id,name,url,token IS NOT NULL AS authenticated,to_char(created_at AT TIME ZONE 'UTC',${timestamp}) AS "createdAt"
          FROM cloud_agent_mcp_connectors WHERE organization_id=$1 AND user_id=$2 ORDER BY name`,
        [actor.organizationId, actor.userId],
      );
      const repositories = await sql.query<{ repositoryId: string }>(
        `SELECT repository_id AS "repositoryId" FROM cloud_agent_allowed_repositories WHERE organization_id=$1 AND user_id=$2 ORDER BY repository_id`,
        [actor.organizationId, actor.userId],
      );
      return {
        connectors: connectors.rows,
        repositoryIds: repositories.rows.map((row) => row.repositoryId),
      };
    });
  }

  async addConnector(
    actor: CloudActor,
    commandId: string,
    input: McpConnectorInput,
  ): Promise<AgentMcpConnector> {
    await this.database.transaction((sql) => requireMembership(sql, actor));
    await this.probe(input);
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const cipher = input.token
        ? await requireCredentialStorage(sql, this.cipher)
        : null;
      return command(
        sql,
        actor,
        commandId,
        { kind: "agent.connector.add", ...input },
        async () => {
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM cloud_agent_mcp_connectors WHERE organization_id=$1 AND user_id=$2",
              [actor.organizationId, actor.userId],
            )
          ).rows[0]!.count;
          if (count >= maximumMcpConnectors)
            throw new CloudError(
              422,
              "connector_limit",
              `Remove a connector first. You can add up to ${maximumMcpConnectors}.`,
            );
          const id = randomUUID();
          const created = await sql.query<AgentMcpConnector>(
            `INSERT INTO cloud_agent_mcp_connectors (organization_id,id,user_id,name,url,token) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (organization_id,user_id,name) DO NOTHING
            RETURNING id,name,url,token IS NOT NULL AS authenticated,to_char(created_at AT TIME ZONE 'UTC',${timestamp}) AS "createdAt"`,
            [
              actor.organizationId,
              id,
              actor.userId,
              input.name,
              input.url,
              cipher && input.token
                ? cipher.encrypt(
                    Buffer.from(input.token),
                    tokenContext(actor, id),
                  )
                : null,
            ],
          );
          if (!created.rows[0])
            throw new CloudError(
              409,
              "connector_exists",
              `A connector named ${input.name} already exists.`,
            );
          return { ...created.rows[0] };
        },
      );
    });
  }

  private async probe(connector: McpConnectorTarget): Promise<void> {
    let client: Client | undefined;
    let tools = 0;
    try {
      client = await this.connect(connector);
      tools = (await client.listTools()).tools.length;
    } catch (error) {
      throw new CloudError(
        422,
        "connector_unavailable",
        `${connector.url} could not be reached: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      await client?.close();
    }
    if (!tools)
      throw new CloudError(
        422,
        "connector_unavailable",
        `${connector.url} offers no tools.`,
      );
  }

  removeConnector(
    actor: CloudActor,
    commandId: string,
    connectorId: string,
  ): Promise<{ removed: boolean }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return command(
        sql,
        actor,
        commandId,
        { kind: "agent.connector.remove", connectorId },
        async () => {
          const removed = await sql.query(
            "DELETE FROM cloud_agent_mcp_connectors WHERE organization_id=$1 AND user_id=$2 AND id=$3 RETURNING id",
            [actor.organizationId, actor.userId, connectorId],
          );
          if (!removed.rows.length)
            throw new CloudError(404, "not_found", "Connector is unavailable.");
          return { removed: true };
        },
      );
    });
  }

  setRepositories(
    actor: CloudActor,
    commandId: string,
    repositoryIds: string[],
  ): Promise<{ repositoryIds: string[] }> {
    const unique = [...new Set(repositoryIds)].sort();
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return command(
        sql,
        actor,
        commandId,
        { kind: "agent.repositories", repositoryIds: unique },
        async () => {
          const known = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM cloud_git_repositories WHERE organization_id=$1 AND id=ANY($2::uuid[])",
              [actor.organizationId, unique],
            )
          ).rows[0]!.count;
          if (known !== unique.length)
            throw new CloudError(
              422,
              "repository_unavailable",
              "Choose connected repositories.",
            );
          await sql.query(
            "DELETE FROM cloud_agent_allowed_repositories WHERE organization_id=$1 AND user_id=$2",
            [actor.organizationId, actor.userId],
          );
          await sql.query(
            `INSERT INTO cloud_agent_allowed_repositories (organization_id,user_id,repository_id)
            SELECT $1,$2,unnest($3::uuid[])`,
            [actor.organizationId, actor.userId, unique],
          );
          return { repositoryIds: unique };
        },
      );
    });
  }

  async openConnectors(actor: CloudActor): Promise<AgentConnectorTools> {
    const targets = await this.database.transaction(async (sql) => {
      const rows = (
        await sql.query<{
          id: string;
          name: string;
          url: string;
          token: Uint8Array | null;
        }>(
          "SELECT id,name,url,token FROM cloud_agent_mcp_connectors WHERE organization_id=$1 AND user_id=$2 ORDER BY name",
          [actor.organizationId, actor.userId],
        )
      ).rows;
      const cipher = rows.some((row) => row.token)
        ? await requireCredentialStorage(sql, this.cipher)
        : null;
      return rows.map(
        (row): McpConnectorTarget => ({
          name: row.name,
          url: row.url,
          token:
            cipher && row.token
              ? cipher
                  .decrypt(Buffer.from(row.token), tokenContext(actor, row.id))
                  .toString("utf8")
              : null,
        }),
      );
    });
    return AgentConnectorTools.open(targets, this.connect);
  }

  repositoryScope(actor: CloudActor): Promise<AgentRepositoryScope> {
    return this.database.transaction((sql) => agentRepositoryScope(sql, actor));
  }
}

export async function hasConnectors(
  sql: CloudSql,
  actor: CloudActor,
): Promise<boolean> {
  return (
    await sql.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM cloud_agent_mcp_connectors WHERE organization_id=$1 AND user_id=$2) AS present",
      [actor.organizationId, actor.userId],
    )
  ).rows[0]!.present;
}
