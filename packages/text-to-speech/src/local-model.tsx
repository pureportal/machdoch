import { useEffect, useState } from "react";
import type { Drama3ModelStatus, SpeechRuntime, SpeechSettings } from "@machdoch/speech";
import type { Run } from "./controls.tsx";

export function LocalModel({ runtime, saved, run, busy }: {
  runtime: SpeechRuntime; saved(settings: SpeechSettings): void; run: Run; busy: boolean;
}) {
  const [status, setStatus] = useState<Drama3ModelStatus | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = status?.state === "downloading" || status?.state === "verifying";
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const current = await runtime.execute("runtimeModelStatus", {});
        if (disposed) return;
        setStatus(current);
        setError(null);
        if (!disposed && (current.state === "downloading" || current.state === "verifying")) timer = setTimeout(() => void refresh(), 750);
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : String(error));
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runtime, active]);
  useEffect(() => {
    if (status?.state !== "installed") return;
    let disposed = false;
    void runtime.execute("settings", {}).then(settings => {
      if (!disposed) saved(settings);
    }).catch(error => {
      if (!disposed) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { disposed = true; };
  }, [runtime, status?.state]);
  return <section className="tts-connection tts-stack" aria-label="Drama 3 local model">
    <div className="tts-row"><h3>Drama 3 · Local</h3>{status?.state === "installed" && <span role="status">Installed</span>}</div>
    {status && status.state !== "installed" && <>
      {active ? <>
        <progress aria-label="Model download" max={status.totalBytes} value={status.bytes} />
        <div className="tts-row"><span role="status">{status.state === "verifying" ? "Verifying model…" : `${(status.bytes / 1073741824).toFixed(1)} / ${(status.totalBytes / 1073741824).toFixed(1)} GiB`}</span>
          <button disabled={busy} onClick={() => void run(async () => setStatus(await runtime.execute("runtimeCancelDownload", {})))}>Pause download</button>
        </div>
      </> : <>
        <label className="tts-check"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
          <span>I accept the <a href={status.licenseUrl} target="_blank" rel="noreferrer">Fish Audio Community License</a></span>
        </label>
        <div className="tts-row"><button className="tts-primary" disabled={busy || !accepted} onClick={() => void run(async () => setStatus(await runtime.execute("runtimeInstallModel", { acceptLicense: accepted })))}>
          {status.state === "paused" || status.state === "failed" ? "Resume download" : "Download model"}
        </button><span className="tts-muted">{(status.totalBytes / 1073741824).toFixed(1)} GiB</span></div>
      </>}
    </>}
    {status?.state === "installed" && <details className="tts-advanced"><summary>Model storage</summary><div className="tts-stack"><span>{status.path}</span>
      <button disabled={busy} onClick={() => void run(async () => {
        if (!window.confirm("Remove the downloaded Drama 3 model? You will need to download it again to generate locally.")) return;
        setStatus(await runtime.execute("runtimeRemoveModel", {}));
        saved(await runtime.execute("settings", {}));
      })}>Remove model</button>
    </div></details>}
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
  </section>;
}
