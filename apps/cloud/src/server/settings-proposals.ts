import type { SettingsItem, SettingsItemKind } from "../lib/settings-items";
import { createId } from "./crypto";
import {
  type DatabaseRow,
  type FleetDatabase,
  requiredNumber,
  requiredString,
} from "./database";
import type { SettingsCipher } from "./settings-crypto";

export const maximumPendingProposalsPerInstance = 50;

export interface SettingsProposal {
  proposalId: string;
  instanceId: string;
  displayName: string;
  kind: SettingsItemKind;
  item: SettingsItem;
  note: string | null;
  createdAt: number;
}

export class SettingsProposalLimitError extends Error {}

const associatedData = (managerId: string, proposalId: string): Buffer =>
  Buffer.from(`machdoch/settings-proposal/${managerId}/${proposalId}`);

const pendingProposals =
  "SELECT s.proposal_id, s.instance_id, i.display_name, s.kind, s.payload_ciphertext, s.created_at\n     FROM settings_proposals s\n     JOIN instances i ON i.instance_id = s.instance_id\n     WHERE s.status = 'pending' AND i.revoked_at IS NULL";

export async function createProposal(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  kind: SettingsItemKind,
  item: SettingsItem,
  note: string | null,
  now: number,
): Promise<string> {
  return await database.transaction(async () => {
    const pending = requiredNumber(
      await database.get(
        "SELECT COUNT(*)::integer AS count FROM settings_proposals WHERE instance_id = $1 AND status = 'pending'",
        instanceId,
      ),
      "count",
    );
    if (pending >= maximumPendingProposalsPerInstance)
      throw new SettingsProposalLimitError(
        "This device has too many pending proposals. Wait until an administrator reviews them.",
      );
    const proposalId = createId("proposal");
    await database.run(
      "INSERT INTO settings_proposals (proposal_id, instance_id, kind, payload_ciphertext, created_at, status)\n       VALUES ($1, $2, $3, $4, $5, 'pending')",
      proposalId,
      instanceId,
      kind,
      cipher.encrypt(
        Buffer.from(JSON.stringify({ item, note })),
        associatedData(await database.managerId(), proposalId),
      ),
      now,
    );
    await database.audit(
      now,
      "settings_proposal.created",
      proposalId,
      "success",
    );
    return proposalId;
  });
}

export async function listProposals(
  database: FleetDatabase,
  cipher: SettingsCipher,
): Promise<SettingsProposal[]> {
  const managerId = await database.managerId();
  return (
    await database.all(
      `${pendingProposals}\n     ORDER BY s.created_at DESC, s.proposal_id`,
    )
  ).map((row) => decodeProposal(cipher, managerId, row));
}

export async function getPendingProposal(
  database: FleetDatabase,
  cipher: SettingsCipher,
  proposalId: string,
): Promise<SettingsProposal | null> {
  const row = await database.get(
    `${pendingProposals} AND s.proposal_id = $1`,
    proposalId,
  );
  return row ? decodeProposal(cipher, await database.managerId(), row) : null;
}

/** Marks a pending proposal resolved; false when it was already resolved. */
export async function resolveProposal(
  database: FleetDatabase,
  proposalId: string,
  status: "accepted" | "rejected",
  profileId: string | null,
  now: number,
): Promise<boolean> {
  return await database.transaction(async () => {
    const changed =
      (await database.run(
        "UPDATE settings_proposals SET status = $1, resolved_at = $2, resolved_profile_id = $3\n         WHERE proposal_id = $4 AND status = 'pending'",
        status,
        now,
        profileId,
        proposalId,
      )) === 1;
    if (changed)
      await database.audit(
        now,
        `settings_proposal.${status}`,
        proposalId,
        "success",
      );
    return changed;
  });
}

function decodeProposal(
  cipher: SettingsCipher,
  managerId: string,
  row: DatabaseRow,
): SettingsProposal {
  const proposalId = requiredString(row, "proposal_id");
  const ciphertext = row.payload_ciphertext;
  if (!(ciphertext instanceof Uint8Array))
    throw new Error("Settings proposal is invalid.");
  const payload = JSON.parse(
    cipher
      .decrypt(Buffer.from(ciphertext), associatedData(managerId, proposalId))
      .toString("utf8"),
  ) as { item: SettingsItem; note: string | null };
  return {
    proposalId,
    instanceId: requiredString(row, "instance_id"),
    displayName: requiredString(row, "display_name"),
    kind: requiredString(row, "kind") as SettingsItemKind,
    item: payload.item,
    note: payload.note ?? null,
    createdAt: requiredNumber(row, "created_at"),
  };
}
