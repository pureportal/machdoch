import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { AssetStorageSettingsPanel } from "../chat-session/components/settings-dialog-panels/asset-storage-settings-panel";
import "../styles.css";

Object.defineProperty(window, "isTauri", { value: true });
const destination = "D:\\Media library\\Models and generated images";
let status = {
  folder:
    "C:\\Users\\Example\\AppData\\Roaming\\com.machdoch.app\\media-studio",
  destination: null as string | null,
  phase: "ready",
  completedBytes: 0,
  totalBytes: 0,
  error: null as string | null,
};
mockIPC((command) => {
  if (command === "plugin:dialog|open") return destination;
  if (command === "media_get_asset_storage") return status;
  if (command === "media_move_asset_storage") {
    status = {
      ...status,
      destination,
      phase: "moving",
      completedBytes: 25,
      totalBytes: 100,
    };
    return status;
  }
  if (command === "media_resume_asset_storage") {
    status = { ...status, phase: "moving", error: null };
    return status;
  }
  throw new Error(`Unexpected command: ${command}`);
});
window.addEventListener("storage-review-state", (event) => {
  const phase = (event as CustomEvent<string>).detail;
  status = {
    ...status,
    phase,
    completedBytes: phase === "cleaning" ? 100 : 25,
    error:
      phase === "paused"
        ? "The destination disk is unavailable. Reconnect it and resume the move."
        : null,
  };
});
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto min-h-screen max-w-xl space-y-6 bg-slate-950 p-5 text-slate-100">
    <h1 className="text-xl font-semibold">Asset storage</h1>
    <AssetStorageSettingsPanel />
  </main>,
);
