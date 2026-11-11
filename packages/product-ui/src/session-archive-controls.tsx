import { Download, Upload } from "lucide-react";
import type { SessionArchiveController } from "./use-session-archive";

export function SessionArchiveControls({
  controller,
}: {
  controller: SessionArchiveController;
}): React.ReactElement {
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
      <button
        type="button"
        className="m-product-icon-button m-product-sidebar-tool"
        aria-label="Import sessions"
        title="Import sessions"
        disabled={disabled}
        onClick={requestImport}
      >
        <Upload aria-hidden="true" />
      </button>
      <button
        type="button"
        className="m-product-icon-button m-product-sidebar-tool"
        aria-label="Export visible sessions"
        title="Export visible sessions"
        disabled={disabled || !canExport}
        onClick={() => void exportSessions()}
      >
        <Download aria-hidden="true" />
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
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
