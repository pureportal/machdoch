import type { FleetOperationTransport } from "@machdoch/product-ui";

let remotePlatform: FleetOperationTransport | null = null;

export function configureRemoteInstructionPlatform(
  platform: FleetOperationTransport,
): void {
  if (remotePlatform)
    throw new Error("An instruction host is already connected.");
  remotePlatform = platform;
}

export const getRemoteInstructionPlatform =
  (): FleetOperationTransport | null => remotePlatform;
