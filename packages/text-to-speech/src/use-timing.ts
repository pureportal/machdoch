import {useEffect, useMemo, useState} from "react";
import {speechTimingViews, type SpeechProject, type SpeechRuntime, type SpeechTake, type SpeechTimingResult} from "@machdoch/speech";

export function useTiming(runtime: SpeechRuntime, project: SpeechProject | null, takes: SpeechTake[]) {
  const key = JSON.stringify([project?.id, project?.timingSelections ?? {}]);
  const [loaded, setLoaded] = useState<{ key: string; records: SpeechTimingResult[] } | null>(null);
  const [failure, setFailure] = useState<{key: string; message: string} | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!project || !Object.keys(project.timingSelections ?? {}).length) return;
    let disposed = false;
    void runtime.execute("resolveTimings", { projectId: project.id, selections: project.timingSelections ?? {} }).then(records => {
      if (!disposed) { setLoaded({key, records}); setFailure(null); }
    }).catch(error => { if (!disposed) setFailure({key, message: error instanceof Error ? error.message : String(error)}); });
    return () => { disposed = true; };
  }, [runtime, key, attempt]);
  const view = useMemo(() => {
    const selections = project?.timingSelections ?? {};
    try { return { takes: speechTimingViews(takes, selections, loaded?.key === key ? loaded.records : null), error: null }; }
    catch (error) { return {takes: speechTimingViews(takes, selections, null), error: error instanceof Error ? error.message : String(error)}; }
  }, [takes, key, loaded]);
  return {takes: view.takes, error: view.error ?? (failure?.key === key ? failure.message : null), reload: () => setAttempt(value => value + 1)};
}
