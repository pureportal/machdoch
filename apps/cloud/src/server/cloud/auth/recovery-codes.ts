import { randomInt } from "node:crypto";
import { hashSecret } from "../../crypto";

const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
const codeLength = 10;
export const recoveryCodeCount = 10;

export function createRecoveryCodes(): string[] {
  return Array.from({ length: recoveryCodeCount }, () => {
    const characters = Array.from(
      { length: codeLength },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
    return `${characters.slice(0, 5)}-${characters.slice(5)}`;
  });
}

export function normalizeRecoveryCode(value: string): string | null {
  const compact = value.toLowerCase().replace(/[\s-]/g, "");
  return new RegExp(`^[${alphabet}]{${codeLength}}$`).test(compact)
    ? compact
    : null;
}

export function hashRecoveryCode(userId: string, code: string): string {
  return hashSecret(`machdoch.cloud/recovery-code/${userId}/${code}`);
}
