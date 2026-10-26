import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const passwordKeyBytes = 32;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelism = 1;

export class CredentialValidationError extends Error {}

export function hashOwnerPassword(password: string): string {
  validateOwnerPassword(password);
  const salt = randomBytes(16);
  const key = derivePasswordKey(password, salt);
  return encodePasswordHash(salt, key);
}

export async function hashOwnerPasswordAsync(
  password: string,
): Promise<string> {
  validateOwnerPassword(password);
  const salt = randomBytes(16);
  const key = await derivePasswordKeyAsync(password, salt);
  return encodePasswordHash(salt, key);
}

function encodePasswordHash(salt: Buffer, key: Buffer): string {
  return [
    "scrypt",
    scryptCost,
    scryptBlockSize,
    scryptParallelism,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyOwnerPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, saltValue, keyValue] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== scryptCost ||
    Number(blockSize) !== scryptBlockSize ||
    Number(parallelism) !== scryptParallelism ||
    !saltValue ||
    !keyValue
  ) {
    return false;
  }
  if (Buffer.byteLength(password) > 1024) return false;
  try {
    const expected = Buffer.from(keyValue, "base64url");
    const salt = Buffer.from(saltValue, "base64url");
    if (
      salt.length !== 16 ||
      expected.length !== passwordKeyBytes ||
      salt.toString("base64url") !== saltValue ||
      expected.toString("base64url") !== keyValue
    ) {
      return false;
    }
    const actual = await derivePasswordKeyAsync(password, salt);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

export function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function validateSecret(value: string, prefix: string): boolean {
  return validatePrefixedValue(value, prefix, 32);
}

export function validateId(value: string, prefix: string): boolean {
  return validatePrefixedValue(value, prefix, 18);
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function verifySecret(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derivePasswordKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, passwordKeyBytes, {
    N: scryptCost,
    r: scryptBlockSize,
    p: scryptParallelism,
    maxmem: 64 * 1024 * 1024,
  });
}

function derivePasswordKeyAsync(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      passwordKeyBytes,
      {
        N: scryptCost,
        r: scryptBlockSize,
        p: scryptParallelism,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export function validateOwnerPassword(password: string): void {
  if ([...password].length < 12) {
    throw new CredentialValidationError(
      "Password must contain at least 12 characters.",
    );
  }
  if (!password.trim())
    throw new CredentialValidationError("Password cannot be blank.");
  if (Buffer.byteLength(password) > 1024)
    throw new CredentialValidationError("Password is too long.");
}

function validatePrefixedValue(
  value: string,
  prefix: string,
  expectedBytes: number,
): boolean {
  if (!value.startsWith(`${prefix}_`)) return false;
  const encoded = value.slice(prefix.length + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
  try {
    return Buffer.from(encoded, "base64url").length === expectedBytes;
  } catch {
    return false;
  }
}
