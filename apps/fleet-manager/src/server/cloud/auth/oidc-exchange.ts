import { randomUUID } from "node:crypto";
import { hashSecret } from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import type { CloudDatabase } from "../database";
import { requireCredentialStorage } from "../credential-storage";
import {
  flowByBrowser,
  providerForFlow,
  flowContext,
  ssoUnavailable as unavailable,
} from "./sso-flow-state";
import type { OidcProof } from "./oidc-protocol";
import { ssoSecretContext } from "./sso-providers";
import { runOidcJob } from "./oidc";

export class CloudOidcExchange {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
  ) {}
  async callback(
    search: string,
    browser: string,
  ): Promise<{ id: string; confirmationId: string | null; failed: boolean }> {
    const params = new URLSearchParams(search);
    if (
      search.length > 16384 ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.get("state") ?? "") ||
      [...params.keys()].some((key) => params.getAll(key).length !== 1)
    )
      throw unavailable();
    const exchangeId = randomUUID();
    const pending = await this.database.transaction(async (sql) => {
      const reference = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_sso_flows WHERE state_hash=$1",
          [hashSecret(params.get("state")!)],
        )
      ).rows[0];
      if (!reference) throw unavailable();
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const flow = await flowByBrowser(sql, reference.id, browser);
      const provider = await providerForFlow(sql, flow);
      if (["verified", "completed"].includes(flow.status))
        return { id: flow.id, confirmationId: flow.invitation_confirmation_id };
      if (flow.status !== "pending" || !flow.proof) throw unavailable();
      const proof = JSON.parse(
        cipher
          .decrypt(
            Buffer.from(flow.proof),
            flowContext(flow.id, flow.browser_hash, "proof"),
          )
          .toString("utf8"),
      ) as OidcProof;
      const secret = cipher
        .decrypt(Buffer.from(provider.secret), ssoSecretContext(provider))
        .toString("utf8");
      await sql.query(
        "UPDATE cloud_sso_flows SET status='exchanging',proof=NULL,exchange_id=$2,exchange_expires_at=clock_timestamp()+interval '25 seconds' WHERE id=$1",
        [flow.id, exchangeId],
      );
      return {
        id: flow.id,
        confirmationId: flow.invitation_confirmation_id,
        provider,
        proof,
        secret,
      };
    });
    if (!pending.provider)
      return {
        id: pending.id,
        confirmationId: pending.confirmationId,
        failed: false,
      };
    try {
      const claims = await runOidcJob(pending.provider.organization_id, {
        kind: "exchange",
        configuration: pending.provider.configuration,
        secret: pending.secret,
        proof: pending.proof,
        redirectUri: `${this.origin}/api/v1/auth/sso/callback`,
        callback: `${this.origin}/api/v1/auth/sso/callback${search}`,
      });
      await this.database.transaction(async (sql) => {
        const flow = await flowByBrowser(sql, pending.id, browser);
        await providerForFlow(sql, flow);
        const updated = await sql.query(
          "UPDATE cloud_sso_flows SET status='verified',claims=$3 WHERE id=$1 AND exchange_id=$2 AND status='exchanging' AND exchange_expires_at>clock_timestamp() RETURNING id",
          [pending.id, exchangeId, JSON.stringify(claims)],
        );
        if (!updated.rows.length) throw unavailable();
      });
      return {
        id: pending.id,
        confirmationId: pending.confirmationId,
        failed: false,
      };
    } catch {
      await this.database.transaction((sql) =>
        sql.query(
          "UPDATE cloud_sso_flows SET status='failed',claims=NULL,proof=NULL WHERE id=$1 AND exchange_id=$2 AND status='exchanging'",
          [pending.id, exchangeId],
        ),
      );
      return {
        id: pending.id,
        confirmationId: pending.confirmationId,
        failed: true,
      };
    }
  }
}
