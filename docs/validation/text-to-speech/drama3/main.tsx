import { createRoot } from "react-dom/client";
import { LocalModel } from "../../../../packages/text-to-speech/src/local-model.tsx";
import "../../../../packages/text-to-speech/src/studio.css";
import type { Drama3ModelStatus, SpeechRuntime } from "@machdoch/speech";

const calls: Array<{ operation: string; input: unknown }> = [];
let refreshes = 0;
let status: Drama3ModelStatus = {
  state: new URLSearchParams(location.search).has("installed") ? "installed" : "idle", bytes: 0, totalBytes: 17053639872, error: null,
  path: "D:\\Models\\machdoch\\speech\\drama3\\drama-3-backbone-8bit-experts-Q2_K.gguf",
  licenseUrl: "https://huggingface.co/Jmica/Drama-3-GGUF/blob/17a5b40c5dc2c2be986f5371a7e650108b828e29/LICENSE",
};
const runtime = { transport: "native", execute: async (operation: string, input: unknown) => {
  calls.push({ operation, input });
  if (operation === "runtimeInstallModel") status = { ...status, state: "downloading", error: null };
  if (operation === "runtimeCancelDownload") status = { ...status, state: "paused" };
  if (operation === "runtimeRemoveModel") status = { ...status, state: "idle", bytes: 0 };
  if (operation === "settings") { refreshes++; return { connections: [] }; }
  return { ...status };
} } as SpeechRuntime;
Object.assign(window, { drama3: {
  calls, setStatus: (change: Partial<Drama3ModelStatus>) => { status = { ...status, ...change }; }, refreshes: () => refreshes,
} });
createRoot(document.getElementById("root")!).render(<LocalModel runtime={runtime} saved={() => {}} busy={false} run={async task => { await task(); }} />);
