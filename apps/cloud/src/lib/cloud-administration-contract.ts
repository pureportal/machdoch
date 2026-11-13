import { z } from "zod";
import { cloudId, revision, type CloudMember } from "./cloud-contract";
import {
  cloudPermissions,
  roleScopes,
  type CloudPermission,
  type RoleScope,
} from "./cloud-permissions";
import {
  brandLogoSchema,
  organizationBrandSchema,
  type OrganizationBrand,
} from "./organization-brand";

export const organizationUpdateSchema = z
  .strictObject({
    revision,
    name: z.string().trim().min(1).max(120),
    brand: organizationBrandSchema,
    logo: brandLogoSchema.nullable(),
  })
  .refine((input) => input.brand.mark !== "image" || input.logo !== null, {
    path: ["logo"],
    message: "Upload an image or choose another mark.",
  });
export const roleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,63}$/u, "Choose an existing role.");
const teamIdList = z
  .array(cloudId)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, "Choose each team once.");
export const memberUpdateSchema = z.strictObject({
  revision,
  role: roleKeySchema,
  active: z.boolean(),
  teamIds: teamIdList.optional(),
});
export const roleInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(""),
  scope: z.enum(roleScopes),
  permissions: z
    .array(z.enum(cloudPermissions as [CloudPermission, ...CloudPermission[]]))
    .max(cloudPermissions.length)
    .refine(
      (permissions) => new Set(permissions).size === permissions.length,
      "Choose each permission once.",
    ),
});
export type RoleInput = z.output<typeof roleInputSchema>;
export const roleUpdateSchema = roleInputSchema.extend({ revision });
export type RoleUpdate = z.output<typeof roleUpdateSchema>;
export interface CloudRoleRecord {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: CloudPermission[];
  builtin: boolean;
  revision: number;
  memberCount: number;
}
export const teamUpdateSchema = z.strictObject({
  revision,
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(["organization", "private"]),
  memberIds: z
    .array(cloudId)
    .max(1000)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Choose each member once.",
    ),
});
export interface CloudOrganization {
  id: string;
  name: string;
  brand: OrganizationBrand;
  logo: string | null;
  revision: number;
}
export interface ManagedMember extends CloudMember {
  email: string | null;
  active: boolean;
  twoFactor: boolean;
  revision: number;
  teamIds: string[];
}
export interface CloudInvitation {
  id: string;
  email: string;
  role: string;
  roleName: string;
  teamIds: string[];
  expiresAt: string;
}
export interface CloudAdministration {
  organization: CloudOrganization;
  members: ManagedMember[];
  invitations: CloudInvitation[];
  roles: CloudRoleRecord[];
  teams: { id: string; key: string; name: string }[];
}
export type OrganizationUpdate = z.infer<typeof organizationUpdateSchema>;
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;

export const settingsTabs = [
  "organization",
  "members",
  "roles",
  "authentication",
  "email",
  "git",
  "mimorii",
] as const;
export type SettingsTab = (typeof settingsTabs)[number];
