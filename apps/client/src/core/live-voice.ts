import type { UserSpeechToTextConfigFile } from "./runtime-contract.generated.js";
import {
  liveVoiceRequestSchema,
  liveVoiceSessionSchema,
  type LiveVoiceSession,
} from "@machdoch/fleet-protocol/live-voice";
import { loadUserConfigFile, loadRuntimeEnvironment } from "./env.js";
import { loadRuntimeConfig } from "./config.js";
import { executeInternalTaskModelInference } from "./internal-task-model.js";
import {
  speechEditingPrompt,
  extractEditedSpeech,
} from "../shared/speech-text.js";

async function requestToken(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `Live voice authorization failed (${response.status}). Check the speech provider's API key and model access.`,
    );
  const text = await response.text();
  if (text.length > 64_000)
    throw new Error("The voice provider returned an oversized session.");
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("The voice provider returned an invalid session.");
  return data as Record<string, unknown>;
}

export async function runLiveVoiceRequest(
  workspaceRoot: string,
  input: unknown,
): Promise<LiveVoiceSession | { text: string }> {
  const request = liveVoiceRequestSchema.parse(input);
  const { config } = await loadUserConfigFile();
  const speech = config.speechToText ?? {};
  const provider = speech.activeProvider;
  if (provider !== "openai" && provider !== "google")
    throw new Error(
      "Select OpenAI or Google speech input in Settings to use live voice.",
    );
  if (request.action === "process") {
    if (!speech.autoFormat && !speech.autoTranslateToEnglish)
      return { text: request.text };
    const runtime = await loadRuntimeConfig(workspaceRoot);
    const turn = await executeInternalTaskModelInference(runtime, {
      systemPrompt: speechEditingPrompt(request.text, {
        autoFormat: speech.autoFormat === true,
        autoTranslateToEnglish: speech.autoTranslateToEnglish === true,
      }),
      userPrompt: "Return the edited transcript.",
      signal: AbortSignal.timeout(120_000),
    });
    return { text: extractEditedSpeech(turn.text) };
  }
  return createLiveVoiceSession(provider, speech);
}

export async function createLiveVoiceSession(
  provider: "openai" | "google",
  speech: UserSpeechToTextConfigFile = {},
): Promise<LiveVoiceSession> {
  const env = await loadRuntimeEnvironment();
  const key = env[provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY"];
  if (!key)
    throw new Error(
      `Configure the ${provider === "openai" ? "OpenAI" : "Google"} API key in Settings before starting live voice.`,
    );
  const keywords = (speech.keyTerms ?? [])
    .filter((term) => typeof term === "string" && term.trim())
    .slice(0, 100)
    .map((term) => term.slice(0, 100));
  if (provider === "openai") {
    const data = await requestToken(
      "https://api.openai.com/v1/realtime/client_secrets",
      { Authorization: `Bearer ${key}` },
      {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: "gpt-live-transcribe",
                keywords,
                ...(speech.speechContext
                  ? { prompt: speech.speechContext.slice(0, 4000) }
                  : {}),
              },
              turn_detection: null,
            },
          },
        },
      },
    );
    return liveVoiceSessionSchema.parse({
      provider,
      token: data.value,
      expiresAt: Number(data.expires_at) * 1000,
      sampleRate: 24000,
    });
  }
  const setup = {
    model: "models/gemini-3.5-transcribe-live",
    generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: { customVocabulary: keywords },
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  };
  const expiresAt = Date.now() + 30 * 60_000;
  const data = await requestToken(
    "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
    { "x-goog-api-key": key },
    {
      uses: 1,
      expireTime: new Date(expiresAt).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
      bidiGenerateContentSetup: setup,
    },
  );
  return liveVoiceSessionSchema.parse({
    provider,
    token: data.name,
    expiresAt,
    sampleRate: 16000,
    setup,
  });
}
