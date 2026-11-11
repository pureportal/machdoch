import { useEffect, type JSX } from "react";
import { McpSettingsPanel } from "../chat-session/components/settings-dialog-panels/mcp-settings-panel";
import { useMcpConfigEditor } from "../mcp-management/use-mcp-config-editor";

export interface WorkspaceMcpSettingsProps {
  workspaceRoot: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export const WorkspaceMcpSettings = ({
  workspaceRoot,
  onDirtyChange,
}: WorkspaceMcpSettingsProps): JSX.Element => {
  const setup = useMcpConfigEditor({ scope: "workspace", workspaceRoot });
  const dirty = setup.draft !== setup.document.raw || setup.saving;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  return <McpSettingsPanel setup={setup} />;
};
