import { Check, X } from "lucide-react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";

export function MessageEditor({
  value,
  pending = false,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  pending?: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <SubmitShortcut asChild>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && value.trim()) onSubmit();
        }}
      >
        <Textarea
          autoFocus
          aria-label="Edit message"
          value={value}
          disabled={pending}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              event.preventDefault();
              onCancel();
            }
          }}
          className="max-h-80 min-h-24 resize-none border-slate-600 bg-slate-950/50 text-slate-100 focus-visible:border-sky-400/60 focus-visible:ring-sky-400/20"
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onCancel}
            className="h-8 rounded-full px-3 text-xs text-slate-300"
          >
            <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !value.trim()}
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
            className="rounded-full bg-sky-600 text-xs text-white hover:bg-sky-500"
          >
            <Check className="mr-1.5 h-3.5 w-3.5" /> Save and submit
          </Button>
        </div>
      </form>
    </SubmitShortcut>
  );
}
