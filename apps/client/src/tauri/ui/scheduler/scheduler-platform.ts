import type { FleetOperationTransport } from "@machdoch/product-ui";

let remotePlatform: FleetOperationTransport | null = null;

export function configureRemoteSchedulerPlatform(
  platform: FleetOperationTransport,
): void {
  if (remotePlatform) throw new Error("A Scheduler host is already connected.");
  remotePlatform = platform;
}

export const getRemoteSchedulerPlatform = (): FleetOperationTransport | null =>
  remotePlatform;
