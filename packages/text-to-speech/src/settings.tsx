import {useState} from "react";
import {PlugZap,Save,Trash2} from "lucide-react";
import type {SpeechSettings,SpeechRuntime,SpeechBackend} from "@machdoch/speech";
import {Field,formNumber,BACKENDS,BACKEND_LABELS,type Run} from "./controls.tsx";
import {LocalModel} from "./local-model.tsx";
import {SpeechDiagnosticsPanel} from "./diagnostics.tsx";
export function SettingsPanel({ runtime, settings, saved, run, busy }: {
  runtime: SpeechRuntime; settings: SpeechSettings; saved(settings: SpeechSettings): void; run: Run; busy: boolean;
}) {
  const [pricingEnabled, setPricingEnabled] = useState(!!settings.pricing);
  const pricing = settings.pricing;
  const [cleanup, setCleanup] = useState<string | null>(null);
  return <div className="tts-stack">
    <h2>Settings</h2>
    {runtime.transport === "native" && <LocalModel runtime={runtime} saved={saved} run={run} busy={busy} />}
    <section className="tts-stack" aria-label="Connections">
      {runtime.transport === "remote" ? settings.connections.map(connection => <div className="tts-row" key={connection.backend}><span>{BACKEND_LABELS[connection.backend]}</span><span>{connection.configured ? "Configured" : "Configure on owning device"}</span></div>) : BACKENDS.filter(backend => backend !== "drama3").map(backend => <ConnectionEditor key={backend} runtime={runtime} backend={backend}
        connection={settings.connections.find(item => item.backend === backend)} run={run} busy={busy}
        saved={connection => saved({ ...settings, connections: [...settings.connections.filter(item => item.backend !== backend), connection] })} />)}
    </section>
    <form className="tts-stack" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void run(async () => {
        let nextPricing: SpeechSettings["pricing"] = null;
        if (pricingEnabled) {
          const effectiveFrom = String(data.get("effectiveFrom")).trim();
          const effectiveTo = String(data.get("effectiveTo")).trim();
          if (!effectiveFrom || !effectiveTo || effectiveTo <= effectiveFrom) throw new Error("Enter valid pricing dates with the end after the start.");
          nextPricing = {
            unit: String(data.get("unit")) as "characters" | "utf8Bytes", perMillion: formNumber(data, "perMillion"),
            currency: String(data.get("currency")).trim(), source: String(data.get("pricingSource")).trim(), effectiveFrom, effectiveTo,
          };
        }
        const result = await runtime.execute("saveSettings", { settings: {
          cloudConsent: data.has("cloudConsent"),
          maxConcurrent: formNumber(data, "maxConcurrent"), budgetLimit: data.get("budgetLimit") ? formNumber(data, "budgetLimit") : null,
          answerBudgetLimit: data.get("answerBudgetLimit") ? formNumber(data, "answerBudgetLimit") : null,
          answerCharacterLimit: formNumber(data, "answerCharacterLimit"), cacheRetentionDays: formNumber(data, "cacheRetentionDays"), pricing: nextPricing,
        } });
        saved(result);
      });
    }}>
      <label className="tts-check"><input name="cloudConsent" type="checkbox" defaultChecked={settings.cloudConsent} />Allow cloud processing of text and audio</label>
      <Field label="Budget limit"><input name="budgetLimit" type="number" min={0} step="any" defaultValue={settings.budgetLimit ?? ""} /></Field>
      <details className="tts-advanced"><summary>Advanced settings</summary><div className="tts-stack"><div className="tts-grid">
        <Field label="Model storage"><input value={settings.modelRoot} readOnly /></Field>
        <Field label="Concurrent jobs"><input name="maxConcurrent" type="number" min={1} max={50} step={1} defaultValue={settings.maxConcurrent} required /></Field>
        <Field label="Automatic speech budget"><input name="answerBudgetLimit" type="number" min={0} step="any" defaultValue={settings.answerBudgetLimit ?? ""} /></Field>
        <Field label="Answer character limit"><input name="answerCharacterLimit" type="number" min={1} max={4294967295} step={1} defaultValue={settings.answerCharacterLimit} required /></Field>
        <Field label="Cache retention (days)"><input name="cacheRetentionDays" type="number" min={0} max={4294967295} step={1} defaultValue={settings.cacheRetentionDays} required /></Field>
      </div>
      <label className="tts-check"><input type="checkbox" checked={pricingEnabled} onChange={event => setPricingEnabled(event.target.checked)} />Set verified pricing</label>
      {pricingEnabled && <fieldset className="tts-grid"><legend>Pricing</legend>
        <Field label="Unit"><select name="unit" defaultValue={pricing?.unit ?? "characters"}><option value="characters">Characters</option><option value="utf8Bytes">UTF-8 bytes</option></select></Field>
        <Field label="Price per million"><input name="perMillion" type="number" step="any" min={0} defaultValue={pricing?.perMillion} required /></Field>
        <Field label="Currency"><input name="currency" pattern="[A-Z]{3}" minLength={3} maxLength={3} defaultValue={pricing?.currency} required /></Field>
        <Field label="Source"><input name="pricingSource" type="url" defaultValue={pricing?.source} required /></Field>
        <Field label="Valid from"><input name="effectiveFrom" type="date" defaultValue={pricing?.effectiveFrom} required /></Field>
        <Field label="Valid until"><input name="effectiveTo" type="date" defaultValue={pricing?.effectiveTo} required /></Field>
      </fieldset>}
      </div></details>
      <div className="tts-row"><button className="tts-primary" disabled={busy}><Save size={16} />Save settings</button></div>
    </form>
    {runtime.transport === "native" && <div className="tts-row"><button type="button" disabled={busy} onClick={() => void run(async () => {
      setCleanup("Cleaning cache…");
      try {
        let pending=true;let restart=true;
        while(pending) {pending=(await runtime.execute("cleanCache",{restart})).pending;restart=false;}
        setCleanup("Cache cleanup finished.");
      } catch(error) {setCleanup(null);throw error;}
    })}>Clean expired audio</button>{cleanup && <span role="status">{cleanup}</span>}</div>}
    <SpeechDiagnosticsPanel runtime={runtime} busy={busy} run={run}/>
  </div>;
}

function ConnectionEditor({ runtime, backend, connection, run, busy, saved }: {
  runtime: SpeechRuntime; backend: SpeechBackend; connection?: SpeechSettings["connections"][number]; run: Run; busy: boolean;
  saved(connection: SpeechSettings["connections"][number]): void;
}) {
  const [secret, setSecret] = useState("");
  return <details className="tts-connection"><summary>{BACKEND_LABELS[backend]}<span className="tts-muted">{connection?.healthy === true ? "Connected" : connection?.configured ? "Configured" : "Not configured"}</span></summary><form className="tts-stack" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const url = String(data.get("url") ?? "").trim();
      const runtimeVersion = String(data.get("runtimeVersion") ?? "").trim();
      const model = String(data.get("model")).trim();
      const result = await runtime.execute("setConnection", {
        backend, ...(secret ? { secret } : {}), ...(backend === "sglang" ? { url, runtimeVersion } : {}), ...(model ? { model } : {}),
      });
      setSecret(""); saved(result);
    });
  }}>
    <div className="tts-connection-status"><span role="status">{connection?.healthy === false ? "Connection failed" : null}</span>
      {connection?.error && <span role="alert">{connection.error}</span>}
    </div>
    <div className="tts-grid">
      {backend === "sglang" && <Field label="Endpoint URL"><input name="url" type="url" defaultValue={connection?.url ?? ""} required /></Field>}
      <Field label="API key"><input type="password" value={secret} autoComplete="off" onChange={event => setSecret(event.target.value)} /></Field>
      <Field label="Model"><input name="model" value={connection?.model ?? ""} readOnly /></Field>
      {backend === "sglang" && <Field label="Runtime version"><input name="runtimeVersion" maxLength={128} defaultValue={connection?.runtimeVersion ?? ""} required /></Field>}
    </div>
    <div className="tts-row">
      <button disabled={busy}><Save size={16} aria-hidden="true" />Save connection</button>
      <button type="button" disabled={busy || !connection?.configured} onClick={() => void run(async () => saved(await runtime.execute("testConnection", { backend })))}><PlugZap size={16} aria-hidden="true" />Test connection</button>
      <button type="button" className="tts-icon-button tts-danger" aria-label="Remove API key" title="Remove API key" disabled={busy || !connection?.configured} onClick={() => void run(async () => {
        if (!window.confirm("Remove the stored API key for " + backend + "?")) return;
        saved(await runtime.execute("setConnection", { backend, deleteSecret: true })); setSecret("");
      })}><Trash2 size={16} aria-hidden="true" /></button>
    </div>
  </form></details>;
}
