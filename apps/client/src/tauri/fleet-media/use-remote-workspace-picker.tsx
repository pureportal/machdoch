import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";

export function useRemoteWorkspacePicker(): {
  chooseDirectory: () => Promise<string | null>;
  dialog: JSX.Element;
} {
  const [opened, setOpened] = useState(false);
  const [path, setPath] = useState("");
  const resolveRef = useRef<((value: string | null) => void) | null>(null);
  const complete = useCallback((value: string | null): void => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpened(false);
  }, []);
  const chooseDirectory = useCallback(
    (): Promise<string | null> =>
      new Promise((resolve) => {
        resolveRef.current?.(null);
        resolveRef.current = resolve;
        setOpened(true);
      }),
    [],
  );
  useEffect(() => () => resolveRef.current?.(null), []);
  return {
    chooseDirectory,
    dialog: (
      <Dialog
        open={opened}
        onOpenChange={(value) => {
          if (!value) complete(null);
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (path.trim()) complete(path.trim());
            }}
          >
            <DialogHeader>
              <DialogTitle>Select workspace</DialogTitle>
            </DialogHeader>
            <label className="mt-4 block space-y-2 text-sm">
              <span>Folder path on device</span>
              <Input
                autoFocus
                value={path}
                maxLength={2048}
                required
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => complete(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!path.trim()}>
                Select folder
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    ),
  };
}
