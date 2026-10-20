import type { AlignedWord } from "./alignment.ts";
import type { SpeechTake } from "./runtime.ts";

export interface SpeechDurationPricing {
  perMinute: number; billingIncrementSeconds: number; currency: string;
  source: string; effectiveFrom: string; effectiveTo: string;
}
export interface SpeechTimingWindow { index: number; from: number; to: number; keepFrom: number; keepTo: number }
export interface SpeechTimingResult {
  id: string; takeId: string; assetId: string; assetSha256: string;
  provider: "openai"; model: "whisper-1"; languageHint: string | null;
  transcript: string; words: AlignedWord[]; createdAt: string; measuredAt: string;
  jobId: string; requestHash: string; reusedFromTimingId: string | null;
  pricing: SpeechDurationPricing | null; estimatedCost: number | null;
  provenance: {
    encoderSha256: string; sourceDuration: number; admittedAt: string;
    sampleRate: 16000; channels: 1; pipeline: 1;
    chunks: Array<{
      window: SpeechTimingWindow; audioSha256: string; responseSha256: string;
      uploadDuration: number; providerText: string; language: string | null;
      usage: { type: "duration"; seconds: number } | null;
    }>;
  };
}
export interface SpeechTimingInput {
  owner: string; takeId: string; provider: "openai"; model: "whisper-1";
  language: string | null; pricing: SpeechDurationPricing | null;
  budgetLimit: number | null; cloudConsent: boolean; reuseCache: boolean;
}

export function speechTimingEstimate(duration: number, pricing: SpeechDurationPricing | null, at = new Date().toISOString().slice(0, 10)): {uploadSeconds: number; billedSeconds: number | null; amount: number | null; currency: string | null} {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 604800) throw new Error("Choose audio within the seven-day timing limit.");
  const windows = Array.from({length: Math.ceil(duration / 600)}, (_, index) => Math.min(duration, (index + 1) * 600 + 1) - Math.max(0, index * 600 - 1));
  const uploadSeconds = windows.reduce((sum, seconds) => sum + seconds, 0);
  if (pricing === null) return {uploadSeconds, billedSeconds: null, amount: null, currency: null};
  if (!Number.isFinite(pricing.perMinute) || pricing.perMinute < 0 || pricing.perMinute > 1_000_000 || !Number.isSafeInteger(pricing.billingIncrementSeconds) || pricing.billingIncrementSeconds < 1 || pricing.billingIncrementSeconds > 3600 || !/^[A-Z]{3}$/u.test(pricing.currency) || !pricing.source.trim() || pricing.source.length > 4096 || /\p{Cc}/u.test(pricing.source)) throw new Error("Enter the complete account rate and billing increment.");
  for (const value of [pricing.effectiveFrom, pricing.effectiveTo, at]) {
    const date = new Date(value + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Enter valid effective pricing dates.");
  }
  if (pricing.effectiveFrom > at || pricing.effectiveTo < at || pricing.effectiveFrom > pricing.effectiveTo) throw new Error("Verify an account rate effective today.");
  const billedSeconds = windows.reduce((sum, seconds) => sum + Math.ceil(seconds / pricing.billingIncrementSeconds) * pricing.billingIncrementSeconds, 0);
  return {uploadSeconds, billedSeconds, amount: billedSeconds / 60 * pricing.perMinute, currency: pricing.currency};
}

export function speechTimingViews(takes: readonly SpeechTake[], selections: Readonly<Record<string, string>>, results: readonly SpeechTimingResult[] | null): SpeechTake[] {
  const records = new Map(results?.map(result => [result.id, result]));
  return takes.map(take => {
    const id = selections[take.id];
    if (!id) return take;
    if (results === null) return { ...take, alignment: [] };
    const result = records.get(id);
    if (!result || result.takeId !== take.id || result.assetId !== take.asset.id || result.assetSha256 !== take.asset.sha256 || result.provenance.sourceDuration !== take.asset.duration) throw new Error("Reload word timing for this take before continuing.");
    let previousStart = 0;
    for (const word of result.words) {
      if (!word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < previousStart || word.end < word.start || word.end > take.asset.duration) throw new Error("The selected word timing is invalid. Choose another timing result.");
      previousStart = word.start;
    }
    if (!result.words.length) throw new Error("This transcript has no measured words. Choose another timing result.");
    return { ...take, alignment: result.words };
  });
}
