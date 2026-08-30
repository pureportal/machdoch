import { describe, expect, it } from "vitest";
import {
  createId,
  createSecret,
  hashOwnerPassword,
  hashSecret,
  validateId,
  validateSecret,
  verifyOwnerPassword,
  verifySecret,
} from "./crypto";

describe("fleet cryptography", () => {
  it("hashes owner passwords and high-entropy credentials", () => {
    const passwordHash = hashOwnerPassword("a sufficiently long password");
    expect(passwordHash).toMatch(/^scrypt\$/);
    expect(
      verifyOwnerPassword("a sufficiently long password", passwordHash),
    ).toBe(true);
    expect(verifyOwnerPassword("the wrong password", passwordHash)).toBe(false);

    const secret = createSecret("mch_enroll");
    expect(validateSecret(secret, "mch_enroll")).toBe(true);
    expect(validateSecret(secret, "mch_instance")).toBe(false);
    expect(verifySecret(secret, hashSecret(secret))).toBe(true);

    const identifier = createId("instance");
    expect(validateId(identifier, "instance")).toBe(true);
    expect(validateId(identifier, "manager")).toBe(false);
  });
});
