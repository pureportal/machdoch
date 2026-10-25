import {
  useEffect,
  useId,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { openExternalUrl } from "../runtime";

export interface CloudConnectionDraft {
  origin: string;
  workspaceRoot: string;
  name: string;
  token: string;
}
export function CloudConnectionForm({
  value,
  existing,
  needsToken,
  busy,
  onChange,
  onSubmit,
  onCancel,
  onError,
}: {
  value: CloudConnectionDraft;
  existing: boolean;
  needsToken: boolean;
  busy: boolean;
  onChange: Dispatch<SetStateAction<CloudConnectionDraft>>;
  onSubmit: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const workspaceId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function update(field: keyof CloudConnectionDraft, next: string) {
    onChange((current) => ({ ...current, [field]: next }));
  }
  const fieldClass =
    "h-9 min-w-0 border-slate-700 bg-slate-950 text-sm text-slate-100";
  const labelClass = "grid min-w-0 gap-1 text-xs text-slate-400";
  let tokenUrl: string | null = null;
  try {
    const url = new URL(value.origin);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      tokenUrl = url.origin + "/cloud/execution";
  } catch {}
  async function chooseWorkspace() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (alive.current && typeof selected === "string")
        onChange((current) => ({
          ...current,
          workspaceRoot: selected,
          name:
            current.name ||
            selected.split(/[\\/]/).filter(Boolean).at(-1) ||
            "",
        }));
    } catch {
      if (alive.current)
        onError(
          "The workspace picker could not open. Retry choosing a folder.",
        );
    }
  }
  return (
    <form
      className="grid min-w-0 gap-3 rounded-lg border border-slate-800 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className={labelClass}>
        Cloud URL
        <Input
          type="url"
          value={value.origin}
          required
          maxLength={2048}
          readOnly={existing}
          autoFocus={!existing}
          disabled={busy}
          onChange={(event) => update("origin", event.currentTarget.value)}
          className={fieldClass}
        />
      </label>
      <div className={labelClass}>
        <label htmlFor={workspaceId}>Workspace</label>
        <div className="flex min-w-0 gap-2">
          <Input
            id={workspaceId}
            value={value.workspaceRoot}
            readOnly
            required
            className={fieldClass}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || existing}
            aria-label="Choose workspace"
            onClick={() => void chooseWorkspace()}
          >
            <FolderOpen className="size-4" />
          </Button>
        </div>
      </div>
      <label className={labelClass}>
        Name
        <Input
          value={value.name}
          required
          maxLength={120}
          readOnly={existing}
          disabled={busy}
          onChange={(event) => update("name", event.currentTarget.value)}
          className={fieldClass}
        />
      </label>
      <label className={labelClass}>
        Runner token
        <Input
          type="password"
          value={value.token}
          required={needsToken}
          maxLength={200}
          autoComplete="off"
          autoFocus={existing}
          disabled={busy}
          onChange={(event) => update("token", event.currentTarget.value)}
          className={fieldClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={
            busy ||
            !value.workspaceRoot ||
            !value.name.trim() ||
            !value.origin.trim() ||
            (needsToken && !value.token.trim())
          }
        >
          {busy ? "Linking…" : existing ? "Reconnect" : "Link workspace"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {tokenUrl && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() =>
              void openExternalUrl(tokenUrl!).catch(() =>
                onError(
                  "The cloud page could not open. Open the cloud address in your browser.",
                ),
              )
            }
          >
            Get runner token
          </Button>
        )}
      </div>
    </form>
  );
}
