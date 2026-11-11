import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const periodSeconds = 30;
const codeDigits = 6;
const allowedDriftSteps = 1;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function createTotpSecret(): Buffer {
  return randomBytes(20);
}

export function encodeBase32(bytes: Buffer): string {
  let output = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += base32Alphabet[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / periodSeconds);
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** codeDigits).padStart(codeDigits, "0");
}

export function isTotpCode(value: string): boolean {
  return new RegExp(`^\\d{${codeDigits}}$`).test(value);
}

export function matchTotp(
  secret: Buffer,
  code: string,
  lastStep: number,
  now = Date.now(),
): number | null {
  if (!isTotpCode(code)) return null;
  const current = totpStep(now);
  const submitted = Buffer.from(code);
  let matched: number | null = null;
  for (
    let step = current - allowedDriftSteps;
    step <= current + allowedDriftSteps;
    step++
  )
    if (
      step > lastStep &&
      timingSafeEqual(Buffer.from(totpCode(secret, step)), submitted)
    )
      matched = step;
  return matched;
}

export function totpUri(issuer: string, account: string, secret: Buffer) {
  const cleanIssuer = issuer.replaceAll(":", " ").trim();
  const label = `${encodeURIComponent(cleanIssuer)}:${encodeURIComponent(account.replaceAll(":", " ").trim())}`;
  const parameters = Object.entries({
    secret: encodeBase32(secret),
    issuer: cleanIssuer,
    algorithm: "SHA1",
    digits: String(codeDigits),
    period: String(periodSeconds),
  })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `otpauth://totp/${label}?${parameters}`;
}
