import { Braces, Plus, X } from "lucide-react";
import { useRef, useState, type FormEvent, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { normalizeChatInputNeededVariableKey } from "@machdoch/client-ui/composer/chat-input-needed-placeholders";

interface VariableRow {
  id: number;
  key: string;
  value: string;
}

const isBlankRow = (row: VariableRow): boolean =>
  !row.key.trim() && !row.value.trim();

export const SessionVariablesControl = ({
  promptVariables,
  onCommit,
}: {
  promptVariables: Record<string, string> | undefined;
  onCommit: (promptVariables: Record<string, string>) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<VariableRow[]>([]);
  const nextRowIdRef = useRef(0);

  const createRow = (key = "", value = ""): VariableRow => ({
    id: nextRowIdRef.current++,
    key,
    value,
  });

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      const entries = Object.entries(promptVariables ?? {});
      setRows(
        entries.length > 0
          ? entries.map(([key, value]) => createRow(key, value))
          : [createRow()],
      );
    }
    setOpen(nextOpen);
  };

  const filledRows = rows.filter((row) => !isBlankRow(row));
  const lookupKeys = filledRows.map((row) =>
    normalizeChatInputNeededVariableKey(row.key),
  );
  const invalidRowIds = new Set(
    filledRows
      .filter(
        (row, index) =>
          !lookupKeys[index] ||
          !row.value.trim() ||
          lookupKeys.indexOf(lookupKeys[index]) !== index,
      )
      .map((row) => row.id),
  );

  const updateRow = (id: number, patch: Partial<VariableRow>): void => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (invalidRowIds.size > 0) {
      return;
    }

    onCommit(
      Object.fromEntries(
        filledRows.map((row) => [row.key.trim(), row.value.trim()]),
      ),
    );
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 rounded-lg border border-transparent px-2 text-[11px] text-slate-300 hover:bg-slate-900 hover:text-white"
        >
          <Braces aria-hidden="true" className="size-4" />
          Variables
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(560px,calc(100vw-28px))] max-w-none gap-0 rounded-xl border-slate-700/80 bg-slate-950 p-0 text-slate-100 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-w-none"
      >
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12 text-left">
          <DialogTitle className="text-base font-semibold text-white">
            Variables
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4 p-5">
          <div className="grid max-h-[50vh] gap-2 overflow-y-auto">
            {rows.map((row) => {
              const invalid = invalidRowIds.has(row.id);

              return (
                <div
                  key={row.id}
                  className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2"
                >
                  <Input
                    value={row.key}
                    aria-label="Name"
                    aria-invalid={invalid}
                    placeholder="Name"
                    onChange={(event) =>
                      updateRow(row.id, { key: event.target.value })
                    }
                    className={cn(
                      "h-9 border-slate-700 bg-slate-900 font-mono text-sm text-slate-100 placeholder:text-slate-500",
                      invalid && "border-rose-500/70",
                    )}
                  />
                  <Input
                    value={row.value}
                    aria-label={`Value for ${row.key || "variable"}`}
                    placeholder="Value"
                    onChange={(event) =>
                      updateRow(row.id, { value: event.target.value })
                    }
                    className="h-9 border-slate-700 bg-slate-900 text-sm text-slate-100 placeholder:text-slate-500"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${row.key || "variable"}`}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((entry) => entry.id !== row.id),
                      )
                    }
                    className="size-9 text-slate-400 hover:bg-slate-900 hover:text-white"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRows((current) => [...current, createRow()])}
            className="justify-self-start text-slate-300 hover:bg-slate-900 hover:text-white"
          >
            <Plus className="size-3.5" />
            Add
          </Button>
          <DialogFooter className="sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              className="text-slate-400 hover:bg-slate-900 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={invalidRowIds.size > 0}
              className="bg-sky-600 text-white hover:bg-sky-700 disabled:bg-slate-800 disabled:text-slate-500"
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
