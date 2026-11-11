import { expect, it } from "vitest";
import {
  encodeBase32,
  isTotpCode,
  matchTotp,
  totpCode,
  totpStep,
  totpUri,
} from "./totp";

const rfcSecret = Buffer.from("12345678901234567890");

it("produces the RFC 6238 SHA-1 reference codes truncated to six digits", () => {
  for (const [seconds, code] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ] as const)
    expect(totpCode(rfcSecret, totpStep(seconds * 1000))).toBe(code);
});

it("encodes secrets as unpadded RFC 4648 base32", () => {
  expect(encodeBase32(Buffer.from("f"))).toBe("MY");
  expect(encodeBase32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  expect(encodeBase32(rfcSecret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
});

it("accepts one step of clock drift and rejects older, newer and replayed codes", () => {
  const now = 1_800_000_000_000;
  const step = totpStep(now);
  expect(matchTotp(rfcSecret, totpCode(rfcSecret, step), 0, now)).toBe(step);
  expect(matchTotp(rfcSecret, totpCode(rfcSecret, step - 1), 0, now)).toBe(
    step - 1,
  );
  expect(matchTotp(rfcSecret, totpCode(rfcSecret, step + 1), 0, now)).toBe(
    step + 1,
  );
  expect(
    matchTotp(rfcSecret, totpCode(rfcSecret, step - 2), 0, now),
  ).toBeNull();
  expect(
    matchTotp(rfcSecret, totpCode(rfcSecret, step + 2), 0, now),
  ).toBeNull();
  expect(matchTotp(rfcSecret, totpCode(rfcSecret, step), step, now)).toBeNull();
  expect(
    matchTotp(rfcSecret, totpCode(rfcSecret, step - 1), step, now),
  ).toBeNull();
});

it("only treats six digits as an authenticator code", () => {
  expect(isTotpCode("123456")).toBe(true);
  for (const value of ["12345", "1234567", "12345a", " 123456", "abcde-fghjk"])
    expect(isTotpCode(value)).toBe(false);
  expect(matchTotp(rfcSecret, "12345a", 0)).toBeNull();
});

it("builds an otpauth URI that authenticator apps can import", () => {
  const uri = new URL(totpUri("Acme: Cloud", "owner@example.test", rfcSecret));
  expect(uri.protocol).toBe("otpauth:");
  expect(uri.host).toBe("totp");
  expect(decodeURIComponent(uri.pathname)).toBe(
    "/Acme  Cloud:owner@example.test",
  );
  expect(Object.fromEntries(uri.searchParams)).toEqual({
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    issuer: "Acme  Cloud",
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  expect(uri.href).not.toContain("+");
});
