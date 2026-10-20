import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createSpeechRuntime,persistPlaybackMetrics,speechPlaybackMetrics } from "@machdoch/speech";

export const speechRuntime = createSpeechRuntime(invoke);
const stopMeasurementStorage=persistPlaybackMetrics(speechPlaybackMetrics,samples=>speechRuntime.execute("recordPlaybackMetrics",{owner:"playback",samples}),message=>console.error(message));
if(import.meta.hot)import.meta.hot.dispose(stopMeasurementStorage);
export const speechAssetUrl = (path: string): string => convertFileSrc(path);
