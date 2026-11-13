import type { GitProvider } from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError } from "../access";
import type { CloudSql } from "../database";
import { gitConnection } from "./connections";

const publicHost = "github.com";

const tokenUsers: Record<GitProvider, string> = {
  github: "x-access-token",
  gitlab: "oauth2",
};

function repositoryKey(url: string): string {
  return url.replace(/\.git$/u, "").toLowerCase();
}

export function sameRepository(left: string, right: string): boolean {
  return repositoryKey(left) === repositoryKey(right);
}

async function connectedRepository(
  sql: CloudSql,
  organizationId: string,
  url: string,
): Promise<GitProvider | null> {
  return (
    (
      await sql.query<{ provider: GitProvider }>(
        "SELECT provider FROM cloud_git_repositories WHERE organization_id=$1 AND lower(web_url)=$2 LIMIT 1",
        [organizationId, repositoryKey(url)],
      )
    ).rows[0]?.provider ?? null
  );
}

export async function requireFetchableRepository(
  sql: CloudSql,
  organizationId: string,
  url: string,
): Promise<void> {
  if (new URL(url).hostname === publicHost) return;
  if (!(await connectedRepository(sql, organizationId, url)))
    throw new CloudError(
      422,
      "repository_unconnected",
      "Add this repository under Settings → Git first.",
    );
}

export async function repositoryAuthorization(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
  url: string,
): Promise<string | null> {
  const provider = await connectedRepository(sql, organizationId, url);
  if (!provider) {
    await requireFetchableRepository(sql, organizationId, url);
    return null;
  }
  const connection = await gitConnection(sql, cipher, organizationId, provider);
  return `Basic ${Buffer.from(`${tokenUsers[provider]}:${connection.token}`).toString("base64")}`;
}
