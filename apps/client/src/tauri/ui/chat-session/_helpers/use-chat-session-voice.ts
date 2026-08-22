import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getProviderLabel } from "../../model-catalog";
import {
  synthesizeUserVoiceAudio,
  type UserVoiceAiProvider,
  type UserVoiceSettings,
} from "../../runtime";
import type {
  ChatSessionMessage,
  ShellVoiceSettings,
} from "../../chat-session.model";
import { createDefaultShellVoiceSettings } from "../../chat-session.model";
import { getSpeechMessageContent } from "./execution-message.tsx";

const MIN_VOICE_RATE = 0.8;
const MAX_VOICE_RATE = 1.4;

export interface ChatSessionVoiceOption {
  voiceURI: string;
  label: string;
  lang: string;
  isDefault: boolean;
}

export interface UseChatSessionVoiceOptions {
  activeSessionId: string;
  settings: ShellVoiceSettings;
  aiVoiceSettings: UserVoiceSettings;
  visibleMessages: ChatSessionMessage[];
  onSettingsChange: (
    updater: (settings: ShellVoiceSettings) => ShellVoiceSettings,
  ) => void;
}

export interface ChatSessionVoiceController {
  supported: boolean;
  systemVoicesSupported: boolean;
  autoSpeakResponses: boolean;
  availabilityDescription: string;
  preferredVoiceURI: string | null;
  rate: number;
  speakingMessageId: string | null;
  voiceOptions: ChatSessionVoiceOption[];
  setAutoSpeakResponses: (enabled: boolean) => void;
  setPreferredVoiceURI: (voiceURI: string | null) => void;
  setRate: (rate: number) => void;
  speakMessage: (message: ChatSessionMessage) => void;
  stopSpeaking: () => void;
}

const clampVoiceRate = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(MAX_VOICE_RATE, Math.max(MIN_VOICE_RATE, value));
};

const canUseSpeechSynthesis = (): boolean => {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
};

const getSpeechController = (): SpeechSynthesis | null => {
  if (!canUseSpeechSynthesis()) {
    return null;
  }

  return window.speechSynthesis;
};

const sortVoices = (
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice[] => {
  return [...voices].sort((left, right) => {
    if (left.default !== right.default) {
      return left.default ? -1 : 1;
    }

    if (left.lang !== right.lang) {
      return left.lang.localeCompare(right.lang);
    }

    return left.name.localeCompare(right.name);
  });
};

const createVoiceOptionLabel = (voice: SpeechSynthesisVoice): string => {
  return `${voice.name} · ${voice.lang}${voice.default ? " · default" : ""}`;
};

const resolveSelectedVoice = (
  voices: SpeechSynthesisVoice[],
  preferredVoiceURI: string | undefined,
): SpeechSynthesisVoice | null => {
  if (voices.length === 0) {
    return null;
  }

  if (preferredVoiceURI) {
    const preferredVoice = voices.find(
      (voice) => voice.voiceURI === preferredVoiceURI,
    );

    if (preferredVoice) {
      return preferredVoice;
    }
  }

  const browserLanguage =
    typeof navigator !== "undefined" ? navigator.language : undefined;
  const matchingLanguageVoice = browserLanguage
    ? voices.find((voice) => voice.lang === browserLanguage)
    : undefined;

  return matchingLanguageVoice ?? voices.find((voice) => voice.default) ?? voices[0];
};

const getConfiguredAiVoiceProvider = (
  settings: UserVoiceSettings,
): UserVoiceAiProvider | null => {
  if (settings.activeProvider === "none") {
    return null;
  }

  return settings.providerAvailability.some(
    (entry) =>
      entry.provider === settings.activeProvider && entry.configured,
  )
    ? settings.activeProvider
    : null;
};

const getLatestSpeakableAgentMessage = (
  messages: ChatSessionMessage[],
): ChatSessionMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "agent") {
      continue;
    }

    if (getSpeechMessageContent(message).length > 0) {
      return message;
    }
  }

  return null;
};

export const useChatSessionVoice = (
  options: UseChatSessionVoiceOptions,
): ChatSessionVoiceController => {
  const voiceSettings = options.settings ?? createDefaultShellVoiceSettings();
  const aiVoiceSettings = options.aiVoiceSettings ?? {
    activeProvider: "none" as const,
    providerAvailability: [],
  };
  const browserSpeechSupported = canUseSpeechSynthesis();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(
    null,
  );
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const playbackRequestIdRef = useRef(0);
  const lastAutoSpokenMessageIdRef = useRef<string | null>(null);
  const autoSpeakPrimedRef = useRef(false);
  const selectedAiVoiceProvider =
    aiVoiceSettings.activeProvider === "none"
      ? null
      : aiVoiceSettings.activeProvider;
  const configuredAiVoiceProvider = useMemo(() => {
    return getConfiguredAiVoiceProvider(aiVoiceSettings);
  }, [aiVoiceSettings]);
  const supported = browserSpeechSupported || configuredAiVoiceProvider !== null;

  const availabilityDescription = useMemo(() => {
    if (selectedAiVoiceProvider) {
      const providerLabel = getProviderLabel(selectedAiVoiceProvider);

      if (configuredAiVoiceProvider === selectedAiVoiceProvider) {
        return browserSpeechSupported
          ? `${providerLabel} AI speech is active. If synthesis fails, machdoch falls back to the current WebView’s system voices.`
          : `${providerLabel} AI speech is active for this desktop session.`;
      }

      return browserSpeechSupported
        ? `${providerLabel} is selected for AI speech, but it is not configured yet. The UI will keep falling back to the current WebView’s system voices.`
        : `${providerLabel} is selected for AI speech, but it is not configured and this WebView does not expose system speech synthesis.`;
    }

    return browserSpeechSupported
      ? "Uses the current WebView’s system voices. Windows WebView2 and macOS WebKit usually expose these directly."
      : "This WebView does not expose speech synthesis. Some Linux WebKitGTK builds still ship without Web Speech TTS support, so the UI falls back gracefully.";
  }, [
    browserSpeechSupported,
    configuredAiVoiceProvider,
    selectedAiVoiceProvider,
  ]);

  useEffect(() => {
    const speechController = getSpeechController();

    if (!speechController) {
      setVoices([]);
      return;
    }

    const updateVoices = (): void => {
      setVoices(sortVoices(speechController.getVoices()));
    };

    updateVoices();
    speechController.addEventListener("voiceschanged", updateVoices);

    return () => {
      speechController.removeEventListener("voiceschanged", updateVoices);
      speechController.cancel();
      setSpeakingMessageId(null);
    };
  }, []);

  const selectedVoice = useMemo(() => {
    return resolveSelectedVoice(voices, voiceSettings.preferredVoiceURI);
  }, [voiceSettings.preferredVoiceURI, voices]);

  const latestSpeakableAgentMessage = useMemo(() => {
    return getLatestSpeakableAgentMessage(options.visibleMessages);
  }, [options.visibleMessages]);

  const voiceOptions = useMemo(() => {
    return voices.map((voice) => ({
      voiceURI: voice.voiceURI,
      label: createVoiceOptionLabel(voice),
      lang: voice.lang,
      isDefault: voice.default,
    }));
  }, [voices]);

  const stopSpeaking = useCallback((): void => {
    playbackRequestIdRef.current += 1;

    const audioElement = audioElementRef.current;

    if (audioElement) {
      audioElement.onended = null;
      audioElement.onerror = null;
      audioElement.pause();
      audioElement.currentTime = 0;
      audioElement.src = "";
      audioElementRef.current = null;
    }

    const speechController = getSpeechController();

    if (!speechController) {
      setSpeakingMessageId(null);
      return;
    }

    speechController.cancel();
    setSpeakingMessageId(null);
  }, []);

  useEffect(() => {
    return () => {
      stopSpeaking();
    };
  }, [stopSpeaking]);

  const speakWithSystemVoice = useCallback(
    (message: ChatSessionMessage, requestId: number): boolean => {
      const speechController = getSpeechController();

      if (!speechController) {
        return false;
      }

      const text = getSpeechMessageContent(message).trim();

      if (!text) {
        return false;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      const activeVoice = resolveSelectedVoice(
        voices,
        voiceSettings.preferredVoiceURI,
      );

      utterance.rate = clampVoiceRate(voiceSettings.rate);

      if (activeVoice) {
        utterance.voice = activeVoice;
        utterance.lang = activeVoice.lang;
      }

      utterance.onend = () => {
        if (playbackRequestIdRef.current !== requestId) {
          return;
        }

        setSpeakingMessageId((currentMessageId) => {
          return currentMessageId === message.id ? null : currentMessageId;
        });
      };
      utterance.onerror = () => {
        if (playbackRequestIdRef.current !== requestId) {
          return;
        }

        setSpeakingMessageId((currentMessageId) => {
          return currentMessageId === message.id ? null : currentMessageId;
        });
      };

      speechController.cancel();
      speechController.speak(utterance);
      return true;
    },
    [voiceSettings.preferredVoiceURI, voiceSettings.rate, voices],
  );

  const playSynthesizedAudio = useCallback(
    async (
      messageId: string,
      providerAudio: Awaited<ReturnType<typeof synthesizeUserVoiceAudio>>,
      requestId: number,
    ): Promise<boolean> => {
      const audioElement = new Audio(
        `data:${providerAudio.mimeType};base64,${providerAudio.audioBase64}`,
      );
      const finishPlayback = (): void => {
        if (audioElementRef.current === audioElement) {
          audioElementRef.current = null;
        }

        if (playbackRequestIdRef.current !== requestId) {
          return;
        }

        setSpeakingMessageId((currentMessageId) => {
          return currentMessageId === messageId ? null : currentMessageId;
        });
      };

      audioElement.onended = finishPlayback;
      audioElement.onerror = finishPlayback;
      audioElementRef.current = audioElement;

      try {
        await audioElement.play();

        if (playbackRequestIdRef.current !== requestId) {
          audioElement.pause();
          audioElement.currentTime = 0;
          return false;
        }

        return true;
      } catch {
        finishPlayback();
        return false;
      }
    },
    [],
  );

  const speakMessage = useCallback(
    (message: ChatSessionMessage): void => {
      if (speakingMessageId === message.id) {
        stopSpeaking();
        return;
      }

      const text = getSpeechMessageContent(message).trim();

      if (!text) {
        return;
      }

      stopSpeaking();
      const requestId = playbackRequestIdRef.current + 1;
      playbackRequestIdRef.current = requestId;
      setSpeakingMessageId(message.id);

      void (async () => {
        if (configuredAiVoiceProvider) {
          try {
            const providerAudio = await synthesizeUserVoiceAudio({
              provider: configuredAiVoiceProvider,
              text,
              languageCode:
                typeof navigator !== "undefined"
                  ? navigator.language
                  : undefined,
              rate: voiceSettings.rate,
            });

            if (playbackRequestIdRef.current !== requestId) {
              return;
            }

            if (
              await playSynthesizedAudio(message.id, providerAudio, requestId)
            ) {
              return;
            }
          } catch (error) {
            console.error("Failed to synthesize AI speech", error);
          }
        }

        if (browserSpeechSupported) {
          if (speakWithSystemVoice(message, requestId)) {
            return;
          }
        }

        if (playbackRequestIdRef.current === requestId) {
          setSpeakingMessageId(null);
        }
      })();
    },
    [
      browserSpeechSupported,
      configuredAiVoiceProvider,
      voiceSettings.rate,
      playSynthesizedAudio,
      speakingMessageId,
      speakWithSystemVoice,
      stopSpeaking,
    ],
  );

  useEffect(() => {
    stopSpeaking();
    autoSpeakPrimedRef.current = false;
    lastAutoSpokenMessageIdRef.current = null;
  }, [options.activeSessionId, stopSpeaking]);

  useEffect(() => {
    const latestMessageId = latestSpeakableAgentMessage?.id ?? null;

    if (!autoSpeakPrimedRef.current) {
      autoSpeakPrimedRef.current = true;
      lastAutoSpokenMessageIdRef.current = latestMessageId;
      return;
    }

    if (!supported || !voiceSettings.autoSpeakResponses) {
      lastAutoSpokenMessageIdRef.current = latestMessageId;
      return;
    }

    if (!latestSpeakableAgentMessage) {
      return;
    }

    if (lastAutoSpokenMessageIdRef.current === latestSpeakableAgentMessage.id) {
      return;
    }

    lastAutoSpokenMessageIdRef.current = latestSpeakableAgentMessage.id;
    speakMessage(latestSpeakableAgentMessage);
  }, [
    latestSpeakableAgentMessage,
    voiceSettings.autoSpeakResponses,
    speakMessage,
    supported,
  ]);

  const setAutoSpeakResponses = useCallback(
    (enabled: boolean): void => {
      options.onSettingsChange((settings) => ({
        ...settings,
        autoSpeakResponses: enabled,
      }));
    },
    [options],
  );

  const setPreferredVoiceURI = useCallback(
    (voiceURI: string | null): void => {
      options.onSettingsChange((settings) => {
        if (voiceURI) {
          return {
            ...settings,
            preferredVoiceURI: voiceURI,
          };
        }

        const nextSettings: ShellVoiceSettings = { ...settings };

        delete nextSettings.preferredVoiceURI;

        return nextSettings;
      });
    },
    [options],
  );

  const setRate = useCallback(
    (rate: number): void => {
      options.onSettingsChange((settings) => ({
        ...settings,
        rate: clampVoiceRate(rate),
      }));
    },
    [options],
  );

  return {
    supported,
    systemVoicesSupported: browserSpeechSupported,
    autoSpeakResponses: voiceSettings.autoSpeakResponses,
    availabilityDescription,
    preferredVoiceURI: selectedVoice?.voiceURI ?? null,
    rate: clampVoiceRate(voiceSettings.rate),
    speakingMessageId,
    voiceOptions,
    setAutoSpeakResponses,
    setPreferredVoiceURI,
    setRate,
    speakMessage,
    stopSpeaking,
  };
};