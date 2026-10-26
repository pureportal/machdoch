import { createSecret, hashSecret, validateSecret } from "../../crypto";
import { randomUUID } from "node:crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError } from "../access";
import type { CloudSql } from "../database";
import { oidcAuthorization, type OidcClaims } from "./oidc-protocol";
import type { SsoProviderRow } from "./sso-providers";

export type SsoFlow = Record<string, unknown> & {
  id: string;
  organization_id: string;
  provider_id: string;
  provider_revision: number;
  policy_epoch: string;
  generation: string;
  browser_hash: string;
  mode: "login" | "link" | "invitation";
  invitation_confirmation_id: string | null;
  user_id: string | null;
  bound_session_hash: string | null;
  authorization_id: string | null;
  proof: Uint8Array | null;
  claims: OidcClaims | null;
  resolved_user_id: string | null;
  resolved_membership_epoch: string | null;
  status: "pending" | "exchanging" | "verified" | "completed" | "failed";
  receipt: Uint8Array | null;
  session_hash: string | null;
};
export function ssoUnavailable() {
  return new CloudError(
    410,
    "sso_expired",
    "This sign-in is unavailable. Start again from the sign-in page.",
  );
}
export function flowContext(
  id: string,
  browserHash: string,
  kind: "proof" | "receipt",
) {
  return Buffer.from(
    JSON.stringify(["cloud.sso.flow", id.toLowerCase(), browserHash, kind]),
  );
}
export async function providerForFlow(
  sql: CloudSql,
  flow: SsoFlow,
): Promise<SsoProviderRow> {
  const row = (
    await sql.query<SsoProviderRow>(
      "SELECT * FROM cloud_sso_providers WHERE organization_id=$1 AND id=$2 AND enabled AND revision=$3 FOR SHARE",
      [flow.organization_id, flow.provider_id, flow.provider_revision],
    )
  ).rows[0];
  const policy = (
    await sql.query<{ epoch: string }>(
      "SELECT authentication_epoch AS epoch FROM cloud_signin_policies WHERE organization_id=$1 FOR SHARE",
      [flow.organization_id],
    )
  ).rows[0];
  if (!row || String(policy?.epoch ?? 0) !== String(flow.policy_epoch))
    throw ssoUnavailable();
  return row;
}
export async function flowByBrowser(
  sql: CloudSql,
  id: string,
  browser: string,
): Promise<SsoFlow> {
  if (!validateSecret(browser, "mch_cloud_sso")) throw ssoUnavailable();
  const row = (
    await sql.query<SsoFlow>(
      "SELECT * FROM cloud_sso_flows WHERE id=$1 AND browser_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE",
      [id, hashSecret(browser)],
    )
  ).rows[0];
  if (!row) throw ssoUnavailable();
  return row;
}

export async function createSsoFlow(
  sql: CloudSql,
  cipher: SettingsCipher,
  origin: string,
  provider: SsoProviderRow,
  browser: string,
  binding:
    | { mode: "login"; authorizationId?: string }
    | { mode: "link"; userId: string; sessionToken: string }
    | { mode: "invitation"; confirmationId: string },
) {
  const epoch =
    (
      await sql.query<{ epoch: string }>(
        "SELECT authentication_epoch AS epoch FROM cloud_signin_policies WHERE organization_id=$1 FOR SHARE",
        [provider.organization_id],
      )
    ).rows[0]?.epoch ?? "0";
  const nonce = validateSecret(browser, "mch_cloud_sso")
    ? browser
    : createSecret("mch_cloud_sso");
  const browserHash = hashSecret(nonce);
  await sql.query(
    "DELETE FROM cloud_sso_flows WHERE id IN (SELECT id FROM cloud_sso_flows WHERE expires_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED)",
  );
  await sql.query(
    "UPDATE cloud_sso_flows SET status='failed',proof=NULL,claims=NULL WHERE status='exchanging' AND exchange_expires_at<=clock_timestamp()",
  );
  if (
    (
      await sql.query(
        "SELECT id FROM cloud_sso_flows WHERE browser_hash=$1 AND status IN ('pending','exchanging','verified')",
        [browserHash],
      )
    ).rows.length >= 8
  )
    throw new CloudError(
      429,
      "sso_flow_limit",
      "Several sign-ins are already open. Finish one or try again in 10 minutes.",
    );
  const { proof, url } = oidcAuthorization(
    provider.configuration,
    `${origin}/api/v1/auth/sso/callback`,
  );
  const target = new URL(url);
  if (binding.mode === "invitation") target.searchParams.set("prompt", "login");
  const id = randomUUID();
  await sql.query(
    `INSERT INTO cloud_sso_flows(id,organization_id,provider_id,provider_revision,policy_epoch,state_hash,browser_hash,mode,user_id,bound_session_hash,authorization_id,proof,invitation_confirmation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      provider.organization_id,
      provider.id,
      provider.revision,
      epoch,
      hashSecret(proof.state),
      browserHash,
      binding.mode,
      binding.mode === "link" ? binding.userId : null,
      binding.mode === "link" ? hashSecret(binding.sessionToken) : null,
      binding.mode === "login" ? (binding.authorizationId ?? null) : null,
      cipher.encrypt(
        Buffer.from(JSON.stringify(proof)),
        flowContext(id, browserHash, "proof"),
      ),
      binding.mode === "invitation" ? binding.confirmationId : null,
    ],
  );
  return { id, nonce, url: target.href };
}
