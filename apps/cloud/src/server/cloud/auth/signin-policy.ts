import type { CloudActor } from "../../../lib/cloud-contract";
import { hashSecret } from "../../crypto";
import {
  CloudError,
  checkRevision,
  command,
  recordEvent,
  requireMembership,
} from "../access";
import { lockAdministration } from "../administration";
import type { CloudDatabase } from "../database";

export class CloudSigninPolicy {
  constructor(private readonly database: CloudDatabase) {}

  passwordAvailable() {
    return this.database.transaction(
      async (sql) =>
        (
          await sql.query(
            "SELECT o.id FROM cloud_organizations o WHERE NOT EXISTS(SELECT 1 FROM cloud_signin_policies p WHERE p.organization_id=o.id AND p.required_sso) LIMIT 1",
          )
        ).rows.length > 0,
    );
  }

  get(actor: CloudActor) {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return (
        (
          await sql.query<{ required: boolean; revision: number }>(
            "SELECT required_sso AS required,revision FROM cloud_signin_policies WHERE organization_id=$1",
            [actor.organizationId],
          )
        ).rows[0] ?? { required: false, revision: 0 }
      );
    });
  }

  save(
    actor: CloudActor,
    key: string,
    input: { required: boolean; revision: number },
    session: string,
  ) {
    return this.database.transaction(async (sql) => {
      if ((await lockAdministration(sql, actor)) !== "owner")
        throw new CloudError(
          403,
          "owner_required",
          "Only an owner can change the sign-in policy.",
        );
      return command(
        sql,
        actor,
        key,
        { kind: "sso.policy", input },
        async () => {
          const current = (
            await sql.query<{ revision: number; required_sso: boolean }>(
              "SELECT * FROM cloud_signin_policies WHERE organization_id=$1 FOR UPDATE",
              [actor.organizationId],
            )
          ).rows[0];
          checkRevision(current?.revision ?? 0, input.revision);
          if ((current?.required_sso ?? false) === input.required)
            return { revision: input.revision };
          const signedIn = await sql.query(
            `SELECT s.token_hash FROM cloud_sessions s JOIN cloud_sso_providers p ON p.id=s.provider_id
          WHERE s.token_hash=$1 AND s.user_id=$2 AND s.organization_id=$3 AND s.authentication_method='oidc'
          AND p.verified_revision=p.revision AND cloud_session_active(s) FOR SHARE OF s,p`,
            [hashSecret(session), actor.userId, actor.organizationId],
          );
          if (!signedIn.rows.length)
            throw new CloudError(
              403,
              "sso_test_required",
              "Sign in through a tested SSO provider before changing this policy.",
            );
          await sql.query(
            `INSERT INTO cloud_signin_policies(organization_id,required_sso) VALUES($1,$2)
          ON CONFLICT(organization_id) DO UPDATE SET required_sso=$2,revision=cloud_signin_policies.revision+1,authentication_epoch=nextval('cloud_authentication_generation')`,
            [actor.organizationId, input.required],
          );
          await recordEvent(
            sql,
            actor,
            "sso.policy.changed",
            actor.organizationId,
            input.revision + 1,
            { required: input.required },
          );
          return { revision: input.revision + 1 };
        },
      );
    });
  }
}
