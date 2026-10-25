import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cloudId } from "../src/lib/cloud-contract";
import { hashOwnerPasswordAsync } from "../src/server/crypto";
import { PostgresCloudDatabase } from "../src/server/cloud/database";

const input = z
  .strictObject({
    connection: z.string().min(1),
    organizationId: cloudId,
    email: z.email().max(254),
    password: z.string().min(12).max(1024),
  })
  .parse({
    connection: process.env.MACHDOCH_CLOUD_DATABASE_URL,
    organizationId: process.env.MACHDOCH_CLOUD_RECOVERY_ORGANIZATION_ID,
    email: process.env.MACHDOCH_CLOUD_OWNER_EMAIL,
    password: process.env.MACHDOCH_CLOUD_OWNER_PASSWORD,
  });
const database = new PostgresCloudDatabase(input.connection);
try {
  const passwordHash = await hashOwnerPasswordAsync(input.password);
  await database.transaction(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `administration:${input.organizationId}`,
    ]);
    const owner = (
      await sql.query<{ id: string }>(
        "SELECT u.id FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE m.organization_id=$1 AND u.email=$2 AND m.role='owner' AND m.active AND NOT u.disabled FOR UPDATE OF u,m",
        [input.organizationId, input.email.toLowerCase()],
      )
    ).rows[0];
    if (!owner)
      throw new Error(
        "No active owner matches the specified organization and email.",
      );
    await sql.query(
      `INSERT INTO cloud_signin_policies(organization_id,required_sso) VALUES($1,false) ON CONFLICT(organization_id) DO UPDATE SET required_sso=false,revision=cloud_signin_policies.revision+1,authentication_epoch=nextval('cloud_authentication_generation')`,
      [input.organizationId],
    );
    await sql.query("UPDATE cloud_users SET password_hash=$2 WHERE id=$1", [
      owner.id,
      passwordHash,
    ]);
    await sql.query(
      "INSERT INTO cloud_operator_audit(id,organization_id,action,payload) VALUES($1,$2,'signin.recovered',$3)",
      [
        randomUUID(),
        input.organizationId,
        JSON.stringify({ ownerId: owner.id }),
      ],
    );
  });
  process.stdout.write(
    "Owner sign-in recovered. Required SSO is off and previous organization sessions and app grants are invalid.\n",
  );
} finally {
  await database.close();
}
