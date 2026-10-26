import { z } from "zod";
import {
  cloudId,
  cloudRoles,
  revision,
  type CloudMember,
} from "./cloud-contract";

export const brandAccents = [
  "sky",
  "violet",
  "emerald",
  "amber",
  "rose",
] as const;
export const organizationUpdateSchema = z.strictObject({
  revision,
  name: z.string().trim().min(1).max(120),
  accent: z.enum(brandAccents),
});
export const memberUpdateSchema = z.strictObject({
  revision,
  role: z.enum(cloudRoles),
  active: z.boolean(),
});
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
  accent: (typeof brandAccents)[number];
  revision: number;
}
export interface ManagedMember extends CloudMember {
  email: string | null;
  active: boolean;
  revision: number;
}
export interface CloudInvitation {
  id: string;
  email: string;
  role: Exclude<CloudMember["role"], "owner">;
  expiresAt: string;
}
export interface CloudAdministration {
  organization: CloudOrganization;
  members: ManagedMember[];
  invitations: CloudInvitation[];
}
export type OrganizationUpdate = z.infer<typeof organizationUpdateSchema>;
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;
