import { LoaderCircle, Save } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { SUBMIT_SHORTCUT_ACTION_PROPS } from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { CustomServerDialog, PresetDialog } from "./mcp-add-server-dialogs";
import type { McpServerEditor } from "./use-mcp-server-editor";

export const McpDraftActions = ({
  editor,
}: {
  editor: McpServerEditor;
}): JSX.Element => {
  const { setup, dirty } = editor;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <PresetDialog editor={editor} />
      <CustomServerDialog editor={editor} />
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-slate-800" />
      {dirty && !setup.saving ? (
        <Button
          type="button"
          variant="ghost"
          onClick={editor.discardChanges}
          className="h-9 rounded-lg px-3 text-sm text-slate-300 hover:bg-slate-900 hover:text-slate-100"
        >
          Discard changes
        </Button>
      ) : null}
      <Button
        type="button"
        disabled={editor.saveDisabled}
        aria-busy={setup.saving}
        onClick={() => {
          void setup.onSave();
        }}
        {...SUBMIT_SHORTCUT_ACTION_PROPS}
        className="h-9 rounded-lg bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-700"
      >
        {setup.saving ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Save className="size-4" />
        )}
        {setup.saving ? "Saving" : "Save changes"}
      </Button>
    </div>
  );
};
