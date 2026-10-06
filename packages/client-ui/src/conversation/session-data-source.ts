import type {
  FleetOperationTransport,
  SessionDataSource,
} from "@machdoch/product-ui";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import {
  sessionIndexPageSchema,
  sessionComposerTextSchema,
  type SessionComposerText,
} from "@machdoch/fleet-protocol/session-data";

export function createSessionDataSource(
  workspace: FleetOperationTransport,
  media: FleetMediaTransport,
): SessionDataSource & {
  composerText: (sessionId: string) => Promise<SessionComposerText>;
} {
  return {
    async composerText(sessionId) {
      return sessionComposerTextSchema.parse(
        await workspace.invoke("get_session_composer_text", { sessionId }),
      );
    },
    async index(query) {
      return sessionIndexPageSchema.parse(
        await workspace.invoke("get_session_index", query),
      );
    },
    export(sessionIds) {
      return workspace.invoke("get_session_export", { sessionIds });
    },
    async import(file) {
      if (file.size > 64 * 1024 * 1024)
        throw new Error(
          "The session export exceeds 64 MiB. Choose a smaller export.",
        );
      const path = await media.upload(file, file.name);
      try {
        await workspace.invoke("import_session_export", { path });
      } finally {
        await media.release(path);
      }
    },
  };
}
