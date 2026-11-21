"use client";

import { useEffect, useMemo, useState } from "react";
import { TextToSpeechStudio } from "@machdoch/text-to-speech";
import { createRemoteSpeechRuntime } from "@machdoch/speech/remote";
import { speechPlayback,persistPlaybackMetrics,speechPlaybackMetrics } from "@machdoch/speech/playback";
import { speechRequestSchema, speechResponseSchema } from "@machdoch/fleet-protocol/speech";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { Button } from "@/components/ui/button";

export function RemoteSpeech({ instanceId }: { instanceId: string }): React.ReactElement {
  const [clientId] = useState(() => {
    if (typeof window === "undefined") return crypto.randomUUID();
    const key = "machdoch:speech-client:" + instanceId;
    const saved = sessionStorage.getItem(key);
    if (saved && /^[0-9a-f-]{36}$/u.test(saved)) return saved;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  });
  const [error, setError] = useState<string | null>(null);
  const runtime = useMemo(() => createRemoteSpeechRuntime(async request => {
    const response = speechResponseSchema.parse(await api<unknown>(`/api/instances/${encodeURIComponent(instanceId)}/product/speech`, {
      method: "POST", body: jsonBody(speechRequestSchema.parse(request)),
    }));
    if (response.state === "events") throw new Error("Unexpected speech event response.");
    return response;
  }, { clientId, disconnectPolicy: "retain", onDiagnostic: setError }), [instanceId, clientId]);
  useEffect(()=>persistPlaybackMetrics(speechPlaybackMetrics,samples=>runtime.execute("recordPlaybackMetrics",{owner:`remote:${clientId}`,samples}),setError),[runtime,clientId]);
  useEffect(() => {
    const timer = setInterval(() => { void runtime.heartbeat().catch(() => setError("Speech connection was lost. Reconnect the owning device.")); }, 15_000);
    const stop = (): void => { speechPlayback.stop(); void runtime.disconnect().catch(() => setError("Remote speech disconnect was interrupted.")); };
    window.addEventListener("pagehide", stop);
    return () => { clearInterval(timer); window.removeEventListener("pagehide", stop); stop(); };
  }, [runtime]);
  return <>
    {error && (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 border-b border-destructive/40 px-4 py-2 text-sm text-destructive"
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void runtime
              .heartbeat()
              .then(() => setError(null))
              .catch(() =>
                setError(
                  "Speech connection is unavailable. Reconnect the owning device.",
                ),
              );
          }}
        >
          Reconnect
        </Button>
      </div>
    )}
    <TextToSpeechStudio runtime={runtime} assetUrl={path => {
      if (!path.startsWith("speech-asset:") && !path.startsWith("speech-export:")) throw new Error("This asset belongs to a different speech runtime.");
      const id = path.slice(path.indexOf(":") + 1);
      return `/api/instances/${encodeURIComponent(instanceId)}/product/speech/assets/${encodeURIComponent(id)}?client=${encodeURIComponent(clientId)}&disconnect=retain`;
    }} />
  </>;
}
