import { useEffect, type JSX } from "react";
import { McpSettingsPanel } from "../chat-session/components/settings-dialog-panels/mcp-settings-panel";
import { useMcpCommands } from "./use-mcp-commands";
import { useMcpConfigEditor } from "./use-mcp-config-editor";

export const McpManager = ({
  workspaceRoot,
  onDirtyChange,
}: {
  workspaceRoot: string | null;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element => {
  const setup = useMcpConfigEditor({ scope: "user", workspaceRoot });
  const dirty = setup.draft !== setup.document.raw || setup.saving;
  useMcpCommands(setup);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  return (
    <main className="app-management-view flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <McpSettingsPanel setup={setup} layout="page" showProviderSync />
    </main>
  );
};
