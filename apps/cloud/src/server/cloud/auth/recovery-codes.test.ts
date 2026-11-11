import { expect, it } from "vitest";
import {
  createRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeCount,
} from "./recovery-codes";

it("creates distinct, readable single-use codes", () => {
  const codes = createRecoveryCodes();
  expect(codes).toHaveLength(recoveryCodeCount);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) {
    expect(code).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
    expect(normalizeRecoveryCode(code)).toBe(code.replace("-", ""));
  }
});

it("normalizes case, spaces and separators but rejects other input", () => {
  expect(normalizeRecoveryCode(" AB2CD-EF3GH ")).toBe("ab2cdef3gh");
  expect(normalizeRecoveryCode("ab2cd ef3gh")).toBe("ab2cdef3gh");
  for (const value of ["123456", "ab2cd-ef3g", "ab2cd-ef3ghj", "ab1cd-ef3gh"])
    expect(normalizeRecoveryCode(value)).toBeNull();
});

it("binds code hashes to the account", () => {
  const code = "ab2cdef3gh";
  expect(hashRecoveryCode("user-a", code)).toBe(
    hashRecoveryCode("user-a", code),
  );
  expect(hashRecoveryCode("user-a", code)).not.toBe(
    hashRecoveryCode("user-b", code),
  );
  expect(hashRecoveryCode("user-a", code)).not.toContain(code);
});
