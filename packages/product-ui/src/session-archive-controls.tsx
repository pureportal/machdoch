import { useRef } from "react";
import { Download, Files, Upload } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { SessionArchiveController } from "./use-session-archive";

export function SessionArchiveControls({
  controller,
}: {
  controller: SessionArchiveController;
}): React.ReactElement {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const {
    fileInput,
    error,
    disabled,
    canExport,
    requestImport,
    exportSessions,
    importFile,
  } = controller;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={menuTrigger}
            type="button"
            className="m-product-icon-button"
            aria-label="Session files"
            disabled={disabled}
          >
            <Files aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal
          container={menuTrigger.current?.closest<HTMLElement>(
            ".machdoch-product",
          )}
        >
          <DropdownMenu.Content
            className="m-product-session-menu"
            sideOffset={6}
          >
            <DropdownMenu.Item
              disabled={disabled || !canExport}
              onSelect={() => void exportSessions()}
            >
              <Download /> Export sessions
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={disabled} onSelect={requestImport}>
              <Upload /> Import sessions
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        aria-label="Import sessions"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void importFile(file);
        }}
      />
      {error ? (
        <p role="alert" className="m-product-inline-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
