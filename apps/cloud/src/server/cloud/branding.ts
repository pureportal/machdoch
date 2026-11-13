import type { CloudOrganization } from "../../lib/cloud-administration-contract";
import type { CloudDatabase } from "./database";

export const organizationColumns =
  'id,name,brand,logo_dark AS "logoDark",logo_light AS "logoLight",revision';

export type SignInBrand = Pick<
  CloudOrganization,
  "name" | "brand" | "logoDark" | "logoLight"
>;

export async function readSignInBrand(
  database: CloudDatabase,
): Promise<SignInBrand | null> {
  return database.transaction(
    async (sql) =>
      (
        await sql.query<SignInBrand & Record<string, unknown>>(
          `SELECT o.name,o.brand,o.logo_dark AS "logoDark",o.logo_light AS "logoLight" FROM cloud_installation i JOIN cloud_organizations o ON o.id=i.organization_id
        WHERE i.id=1 AND (o.brand->>'signIn')::boolean`,
        )
      ).rows[0] ?? null,
  );
}
