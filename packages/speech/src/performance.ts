import type {SpeechPreferences, SpeechTakeRequest} from "./runtime.ts";
import {estimateSpeechRender} from "./pricing.ts";

export function performanceDirection(original: string, note: string): string {
  const encoder=new TextEncoder();
  if (!note.trim() || encoder.encode(note).length>4096 || /[<>[\]\p{Cc}]/u.test(note)) throw new Error("Enter a single-line director note without speech control delimiters, within 4,096 UTF-8 bytes.");
  const direction=original ? `${original}; ${note}` : note;
  if (encoder.encode(direction).length>32768) throw new Error("Shorten the director note or choose a take with a shorter original direction; the combined local limit is 32,768 UTF-8 bytes.");
  return direction;
}

export function estimateSpeechPerformance(request: SpeechTakeRequest, note: string, takes: number, pricing: SpeechPreferences["pricing"], at=new Date().toISOString().slice(0,10)): {direction: string; characters: number; utf8Bytes: number; amount: number|null; currency: string|null} {
  if (!["fish-cloud","sglang","drama3"].includes(request.profile.backend) || request.profile.model!=="drama-3") throw new Error("Choose a Drama 3 take for director-note regeneration.");
  const direction=performanceDirection(request.profile.direction,note);
  return {direction,...estimateSpeechRender([request.segment.text],{...request.profile,direction},takes,pricing,at)};
}
