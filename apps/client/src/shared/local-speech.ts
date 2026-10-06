import type { SpeechToTextProvider } from "../core/runtime-contract.generated.js";

export const LOCAL_SPEECH_PROVIDERS = [
  "whisper",
  "whisper-tiny",
  "whistle",
  "whistle-tiny",
  "phonon2",
] as const;
export type LocalSpeechProvider = (typeof LOCAL_SPEECH_PROVIDERS)[number];

export const isLocalSpeechProvider = (
  provider: string,
): provider is LocalSpeechProvider =>
  LOCAL_SPEECH_PROVIDERS.some((value) => value === provider);

export const speechProviderLabel = (provider: SpeechToTextProvider): string =>
  ({
    none: "Disabled",
    openai: "OpenAI",
    google: "Google",
    whisper: "Whisper base",
    "whisper-tiny": "Whisper tiny",
    whistle: "Whistle",
    "whistle-tiny": "Whistle lightweight",
    phonon2: "Phonon-2 (English)",
  })[provider];
