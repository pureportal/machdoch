import type { ConversationMemoryEntry } from "../../../core/types.js";
import type { MemorySourceSession } from "../components/memory-management-entries";

export interface WorkspaceManagementControls {
  workspaceRoots: string[];
  memorySourceSessions: MemorySourceSession[];
  loading: boolean;
  onAdd: (workspaceRoot: string) => void;
  onRemove: (workspaceRoot: string) => void | Promise<void>;
  onRelink: (
    currentWorkspaceRoot: string,
    nextWorkspaceRoot: string,
  ) => void | Promise<void>;
  onLoadMemory: (workspaceRoot: string) => Promise<ConversationMemoryEntry[]>;
  onForgetMemory: (
    workspaceRoot: string,
    id: string,
  ) => Promise<ConversationMemoryEntry[]>;
}
