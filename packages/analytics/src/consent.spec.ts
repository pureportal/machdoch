import { beforeEach, describe, expect, it } from "vitest";
import { NOTICE_REVISION } from "./catalog.js";
import {
  consentKey,
  hasPrivacySignal,
  readConsent,
  writeConsent,
} from "./consent.js";

beforeEach(() => localStorage.clear());
describe("analytics consent", () => {
  it("requires a separate choice for each app", () => {
    expect(readConsent(localStorage, "software")).toBeNull();
    writeConsent(localStorage, "landing", true);
    expect(readConsent(localStorage, "landing")?.enabled).toBe(true);
    expect(readConsent(localStorage, "fleet")).toBeNull();
  });
  it.each(["invalid", "{}", '{"enabled":true}', '{"enabled":"true"}'])(
    "rejects malformed consent %s",
    (raw) => {
      localStorage.setItem(consentKey("fleet"), raw);
      expect(readConsent(localStorage, "fleet")).toBeNull();
    },
  );
  it("expires consent and requires consent again when the notice changes", () => {
    writeConsent(localStorage, "fleet", true);
    const current = readConsent(localStorage, "fleet")!;
    expect(readConsent(localStorage, "fleet", current.expiresAt)).toBeNull();
    localStorage.setItem(
      consentKey("fleet"),
      JSON.stringify({ ...current, revision: "old" }),
    );
    expect(readConsent(localStorage, "fleet")).toBeNull();
  });
  it("rejects future dates and forged lifetimes", () => {
    const future = Date.now() + 100_000;
    localStorage.setItem(
      consentKey("fleet"),
      JSON.stringify({
        enabled: true,
        revision: NOTICE_REVISION,
        updatedAt: future,
        expiresAt: future + 1_000_000,
      }),
    );
    expect(readConsent(localStorage, "fleet")).toBeNull();
  });
  it("honors Do Not Track and Global Privacy Control", () => {
    expect(hasPrivacySignal({ doNotTrack: "1" } as Navigator)).toBe(true);
    expect(
      hasPrivacySignal({ globalPrivacyControl: true } as unknown as Navigator),
    ).toBe(true);
    expect(hasPrivacySignal({ doNotTrack: "0" } as Navigator)).toBe(false);
  });
});
