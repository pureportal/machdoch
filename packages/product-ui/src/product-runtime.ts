import type {
  CommandReceipt,
  ProductCommand,
  ProductSnapshot,
} from "@machdoch/fleet-protocol";

export interface ProductRuntime {
  servicesHref?: string;
  getSnapshot(signal?: AbortSignal): Promise<ProductSnapshot>;
  execute(
    command: ProductCommand,
    signal?: AbortSignal,
  ): Promise<CommandReceipt>;
}

export type ProductCommandHandler = (
  command: ProductCommand,
) => Promise<boolean>;
