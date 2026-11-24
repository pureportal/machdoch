import { z } from "zod";
import { cloudId, projectUpdateCadences } from "./cloud-contract";
import { loopHarnesses, loopPlacements } from "./cloud-loop-contract";

export const settingScopes = ["user", "organization", "team"] as const;
export type SettingScope = (typeof settingScopes)[number];

const instructions = z.string().trim().max(20_000);

export const userSettingSchemas = {
  "review.diffLayout": z.enum(["unified", "split"]),
  "review.showWhitespace": z.boolean(),
  "agent.instructions": instructions,
  "agent.model": z
    .strictObject({
      providerId: cloudId,
      model: z.string().trim().min(1).max(160),
    })
    .nullable(),
  "agent.harness": z.enum(loopHarnesses),
  "agent.placement": z.enum(loopPlacements),
} as const;

export const organizationSettingSchemas = {
  "agent.instructions": instructions,
  "projects.updateCadence": z.enum(projectUpdateCadences),
} as const;

export const teamSettingSchemas = {
  "agent.instructions": instructions,
} as const;

export const settingSchemas = {
  user: userSettingSchemas,
  organization: organizationSettingSchemas,
  team: teamSettingSchemas,
} as const;

export type SettingKey<Scope extends SettingScope> =
  keyof (typeof settingSchemas)[Scope] & string;
export type SettingValue<
  Scope extends SettingScope,
  Key extends SettingKey<Scope>,
> = z.infer<(typeof settingSchemas)[Scope][Key]>;

export function isSettingKey<Scope extends SettingScope>(
  scope: Scope,
  key: string,
): key is SettingKey<Scope> {
  return Object.hasOwn(settingSchemas[scope], key);
}

export function parseSettingValue<
  Scope extends SettingScope,
  Key extends SettingKey<Scope>,
>(scope: Scope, key: Key, value: unknown): SettingValue<Scope, Key> {
  const schema = settingSchemas[scope][key] as z.ZodType;
  return schema.parse(value) as SettingValue<Scope, Key>;
}

export const settingWriteSchema = z.strictObject({
  scope: z.enum(settingScopes),
  teamId: z.uuid().optional(),
  key: z.string().min(1).max(100),
  value: z.unknown(),
});
export type SettingWrite = z.infer<typeof settingWriteSchema>;
