import {
  NOTICE_REVISION,
  type AnalyticsApp,
} from "@machdoch/analytics/catalog";

const CONSENT_LIFETIME_MS = 183 * 24 * 60 * 60 * 1000;
export const consentKey = (app: AnalyticsApp): string =>
  `machdoch:analytics:${app}`;

export interface AnalyticsConsent {
  enabled: boolean;
  revision: string;
  updatedAt: number;
  expiresAt: number;
}

export function readConsent(
  storage: Pick<Storage, "getItem">,
  app: AnalyticsApp,
  now = Date.now(),
): AnalyticsConsent | null {
  try {
    const raw = storage.getItem(consentKey(app));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AnalyticsConsent>;
    if (
      typeof value.enabled !== "boolean" ||
      value.revision !== NOTICE_REVISION ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt) ||
      value.updatedAt > now ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt - value.updatedAt !== CONSENT_LIFETIME_MS
    )
      return null;
    return value as AnalyticsConsent;
  } catch {
    return null;
  }
}

export function writeConsent(
  storage: Pick<Storage, "setItem">,
  app: AnalyticsApp,
  enabled: boolean,
): void {
  const updatedAt = Date.now();
  storage.setItem(
    consentKey(app),
    JSON.stringify({
      enabled,
      revision: NOTICE_REVISION,
      updatedAt,
      expiresAt: updatedAt + CONSENT_LIFETIME_MS,
    } satisfies AnalyticsConsent),
  );
}

export function hasPrivacySignal(navigation: Navigator): boolean {
  return (
    navigation.doNotTrack === "1" ||
    (navigation as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true
  );
}
