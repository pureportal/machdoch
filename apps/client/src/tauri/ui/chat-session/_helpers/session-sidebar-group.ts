import type { SessionSidebarGroup } from "@machdoch/product-ui";
import {
  isQuickVoiceSession,
  type ChatSessionRecord,
} from "../../chat-session.model";

export const getSessionSidebarGroup = (
  session: ChatSessionRecord,
): SessionSidebarGroup => ({
  quick: isQuickVoiceSession(session),
  pinned: typeof session.pinnedAt === "number",
});
