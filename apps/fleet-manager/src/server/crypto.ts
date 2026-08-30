import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const passwordKeyBytes = 32;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelism = 1;

export function hashOwnerPassword(
  password: string,
  minimumCharacters = 12,
): string {
  validatePassword(password, minimumCharacters);
  const salt = randomBytes(16);
  const key = derivePasswordKey(password, salt);
  return [
    "scrypt",
    scryptCost,
    scryptBlockSize,
    scryptParallelism,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export function verifyOwnerPassword(
  password: string,
  encoded: string,
): boolean {
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
  try {
    const expected = Buffer.from(keyValue, "base64url");
    const actual = derivePasswordKey(
      password,
      Buffer.from(saltValue, "base64url"),
    );
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

function validatePassword(password: string, minimumCharacters: number): void {
  if ([...password].length < minimumCharacters) {
    throw new Error(
      `Password must contain at least ${minimumCharacters} characters.`,
    );
  }
  if (Buffer.byteLength(password) > 1024)
    throw new Error("Password is too long.");
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
