import type { CloudOrganization } from "../../lib/cloud-administration-contract";
import type { CloudDatabase } from "./database";

export const organizationColumns = "id,name,brand,logo,revision";

export type SignInBrand = Pick<CloudOrganization, "name" | "brand" | "logo">;

export async function readSignInBrand(
  database: CloudDatabase,
): Promise<SignInBrand | null> {
  return database.transaction(
    async (sql) =>
      (
        await sql.query<SignInBrand & Record<string, unknown>>(
          `SELECT o.name,o.brand,o.logo FROM cloud_installation i JOIN cloud_organizations o ON o.id=i.organization_id
        WHERE i.id=1 AND (o.brand->>'signIn')::boolean`,
        )
      ).rows[0] ?? null,
  );
}
