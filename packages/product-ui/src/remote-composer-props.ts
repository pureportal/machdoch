import type { ProductSession, ProductShell } from "@machdoch/fleet-protocol";
import type { ComposerDraftStore } from "./use-composer-draft";
import type { ProductCommandHandler } from "./product-runtime";

export interface RemoteComposerProps {
  composer: NonNullable<ProductShell["composer"]>;
  session: ProductSession;
  contextPacks: ProductShell["contextPacks"];
  workspaces: ProductShell["workspaces"];
  webSearchAvailable: boolean;
  voice?: ProductShell["voice"];
  canCancel: boolean;
  drafts: ComposerDraftStore;
  pending: boolean;
  onCommand: ProductCommandHandler;
  onBrowseMediaAssets?: (() => void) | undefined;
  onCreateMediaAsset?: ((prompt: string) => void) | undefined;
}
