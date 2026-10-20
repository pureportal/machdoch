import type { SpeechBackend, SpeechTake, SpeechTakeRequest } from "./runtime.ts";

export interface SpeechVoiceAuditionTake {
  take: SpeechTake;
  request: SpeechTakeRequest;
}

export interface SpeechVoiceAuditionInput {
  id: string;
  takeId: string;
  voiceId: string;
  language: string;
  reviewer: string;
  reviewedAt: string;
  listened: boolean;
  verdict: "approved" | "rejected";
  note: string;
}

export interface SpeechVoiceAudition extends SpeechVoiceAuditionInput {
  listened: true;
  assetId: string;
  audioSha256: string;
  requestHash: string;
  backend: SpeechBackend;
  model: string;
  generatedAt: string;
}

export interface SpeechVoiceLanguageAudition {
  backend: SpeechBackend;
  model: string;
  voiceId: string;
  language: string;
  reviews: SpeechVoiceAudition[];
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(label + " is required.");
  }
  return value.trim();
}

function hash(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(label + " must be a SHA-256 hash.");
  }
  return value.toLowerCase();
}

function timestamp(value: string, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(label + " must be a valid UTC timestamp.");
  }
  return value;
}

export function createSpeechVoiceAudition(
  input: SpeechVoiceAuditionInput,
  takes: readonly SpeechVoiceAuditionTake[],
): SpeechVoiceAudition {
  const id = requiredText(input.id, "Review ID");
  const takeId = requiredText(input.takeId, "Take ID");
  const matches = takes.filter(item => item.take.id === takeId);
  if (matches.length !== 1) {
    throw new Error("Choose one existing take with its saved request.");
  }
  const { take, request } = matches[0]!;
  if (!["drama3", "fish-cloud", "sglang", "openai", "google"].includes(take.backend)
    || !take.model || take.model.trim() !== take.model
    || request.connection.backend !== take.backend || request.connection.model !== take.model
    || request.profile.backend !== take.backend || request.profile.model !== take.model
    || request.segment.id !== take.segmentId || request.segment.spokenText !== take.spokenText) {
    throw new Error("The saved request does not match this take. Reload the take before reviewing it.");
  }
  if (request.segment.voiceIds.length !== 1 || !request.segment.voiceIds[0]?.trim()) {
    throw new Error("Render a take with exactly one voice to review a voice-language combination.");
  }
  const voiceId = requiredText(input.voiceId, "Voice ID");
  if (request.segment.voiceIds[0] !== voiceId) {
    throw new Error("Choose the voice used by this take.");
  }
  const assetId = requiredText(take.asset.id, "Audio asset ID");
  const audioSha256 = hash(take.asset.sha256, "Audio");
  const requestHash = hash(take.requestHash, "Request");
  if (!Number.isSafeInteger(take.asset.bytes) || take.asset.bytes <= 0
    || !Number.isFinite(take.asset.duration) || take.asset.duration <= 0) {
    throw new Error("This take has no completed audio to review.");
  }
  const language = requiredText(input.language, "Language");
  let canonicalLanguage: string;
  try {
    canonicalLanguage = Intl.getCanonicalLocales(language)[0]!;
  } catch {
    throw new Error("Enter a language tag such as en, de, or ja.");
  }
  if (/^(und|mul|zxx)(-|$)/i.test(canonicalLanguage)) {
    throw new Error("Choose the specific spoken language you reviewed.");
  }
  const generatedAt = timestamp(take.generatedAt, "Generation time");
  const reviewedAt = timestamp(input.reviewedAt, "Review time");
  if (reviewedAt < generatedAt) {
    throw new Error("Review time cannot precede generation.");
  }
  if (input.listened !== true) {
    throw new Error("Listen to this take and confirm listening before saving a review.");
  }
  if (input.verdict !== "approved" && input.verdict !== "rejected") {
    throw new Error("Choose a listening verdict.");
  }
  if (typeof input.note !== "string") {
    throw new Error("Review notes must be text.");
  }
  return {
    id, takeId, assetId, audioSha256, requestHash, backend: take.backend, model: take.model,
    generatedAt, voiceId, language: canonicalLanguage,
    reviewer: requiredText(input.reviewer, "Reviewer"), reviewedAt, listened: true,
    verdict: input.verdict, note: input.note.trim(),
  };
}

export function validateSpeechVoiceAudition(
  review: SpeechVoiceAudition,
  takes: readonly SpeechVoiceAuditionTake[],
): void {
  const verified = createSpeechVoiceAudition(review, takes);
  const fields = [
    "id", "takeId", "assetId", "audioSha256", "requestHash", "backend", "model",
    "generatedAt", "voiceId", "language", "reviewer", "reviewedAt", "listened", "verdict", "note",
  ] as const;
  if (fields.some(field => review[field] !== verified[field])) {
    throw new Error("Review " + review.id + " does not match its take evidence. Remove it and review the take again.");
  }
}

export function addSpeechVoiceAudition(
  reviews: readonly SpeechVoiceAudition[],
  input: SpeechVoiceAuditionInput,
  takes: readonly SpeechVoiceAuditionTake[],
): SpeechVoiceAudition[] {
  const review = createSpeechVoiceAudition(input, takes);
  if (reviews.some(item => item.id === review.id)) {
    throw new Error("This review ID already exists. Save a new review.");
  }
  return [...reviews, review];
}

export function removeSpeechVoiceAudition(
  reviews: readonly SpeechVoiceAudition[],
  id: string,
): SpeechVoiceAudition[] {
  if (reviews.filter(review => review.id === id).length !== 1) {
    throw new Error("This review is unavailable or duplicated. Reload reviews before removing it.");
  }
  return reviews.filter(review => review.id !== id);
}

export function speechVoiceLanguageAuditionMatrix(
  reviews: readonly SpeechVoiceAudition[],
  takes: readonly SpeechVoiceAuditionTake[],
): SpeechVoiceLanguageAudition[] {
  const matrix = new Map<string, SpeechVoiceLanguageAudition>();
  const ids = new Set<string>();
  for (const review of reviews) {
    validateSpeechVoiceAudition(review, takes);
    if (ids.has(review.id)) throw new Error("Duplicate review ID: " + review.id);
    ids.add(review.id);
    const key = JSON.stringify([review.backend, review.model, review.voiceId, review.language]);
    let entry = matrix.get(key);
    if (!entry) {
      entry = { backend: review.backend, model: review.model, voiceId: review.voiceId, language: review.language, reviews: [] };
      matrix.set(key, entry);
    }
    entry.reviews.push({ ...review });
  }
  return [...matrix.values()];
}
