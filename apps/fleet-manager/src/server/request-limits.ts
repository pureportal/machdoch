import { maximumGatewayMessageBytes } from "@machdoch/fleet-protocol";
import type { FleetManagerConfig } from "./config";

const maximumAuthenticationBodyBytes = 16 * 1024;
const maximumSettingsSyncReportBodyBytes = 16 * 1024;
const maximumSmallApiBodyBytes = 64 * 1024;
export const maximumMediaRequestBodyBytes = 2_250_000;
export const maximumFleetSessionRequestBodyBytes = 80 * 1024;

export function maximumRequestBodyBytes(
  pathname: string,
  config: FleetManagerConfig,
): number {
  if (pathname === "/api/fleet/sessions")
    return maximumFleetSessionRequestBodyBytes;
  if (pathname === "/api/auth/login" || pathname === "/api/auth/account") {
    return maximumAuthenticationBodyBytes;
  }
  if (/^\/api\/client\/settings\/[^/]+\/sync-status$/u.test(pathname)) {
    return maximumSettingsSyncReportBodyBytes;
  }
  if (/^\/api\/client\/settings\/[^/]+\/enrollment$/u.test(pathname))
    return config.settingsManager.limits.maximumDocumentBytes;
  if (/^\/api\/instances\/[^/]+\/product\/commands$/u.test(pathname)) {
    return maximumGatewayMessageBytes;
  }
  if (/^\/api\/instances\/[^/]+\/product\/(?:media|ralph)$/u.test(pathname)) {
    return maximumMediaRequestBodyBytes;
  }
  if (/^\/api\/instances\/[^/]+\/runs$/u.test(pathname))
    return 1024 * 1024 + maximumSmallApiBodyBytes;
  if (pathname.startsWith("/api/settings/")) {
    return (
      Math.max(
        config.settingsManager.limits.maximumDocumentBytes,
        config.settingsManager.limits.maximumSecretBytes,
      ) + maximumSmallApiBodyBytes
    );
  }
  return maximumSmallApiBodyBytes;
}
