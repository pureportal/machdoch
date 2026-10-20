import { cloneElement, useId, type ReactElement } from "react";
import type { SpeechBackend, SpeechExportInput } from "@machdoch/speech";
export type Run = (task: () => Promise<unknown>) => Promise<void>;
export const OWNER = "text-to-speech";
export const BACKENDS: SpeechBackend[] = ["drama3", "fish-cloud", "sglang", "openai", "google"];
export const BACKEND_LABELS: Record<SpeechBackend, string> = { drama3: "Drama 3 · Local", "fish-cloud": "Fish Audio", sglang: "Self-hosted", openai: "OpenAI", google: "Google" };
export const FORMATS: SpeechExportInput["format"][] = ["wav", "mp3", "opus", "flac", "m4b", "srt", "vtt", "txt", "json", "archive"];
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="tts-field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}

export function formNumber(data: FormData, name: string): number {
  const raw = String(data.get(name) ?? "").trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) throw new Error("Enter a number for " + name + ".");
  return value;
}
