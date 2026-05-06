import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getProviderLabel } from "../../model-catalog";
import {
	transcribeUserSpeechAudio,
	type SpeechToTextProvider,
	type UserSpeechToTextProvider,
	type UserSpeechToTextSettings,
} from "../../runtime";
import {
	assertRecordedSpeechDetected,
	createSpeechInputAudioConstraints,
} from "./speech-audio";

const GOOGLE_SUPPORTED_MIME_TYPES = new Set([
	"audio/wav",
	"audio/mp3",
	"audio/aiff",
	"audio/aac",
	"audio/ogg",
	"audio/flac",
]);

const RECORDING_MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
	"audio/ogg;codecs=opus",
	"audio/ogg",
] as const;
const VOICE_LEVEL_MONITOR_INTERVAL_MS = 120;

export type SpeechInputStatusTone = "success" | "error" | "info";

export interface UseChatSessionSpeechInputOptions {
	activeSessionId: string;
	settings: UserSpeechToTextSettings;
	onTranscript: (sessionId: string, transcript: string) => void;
}

export interface ChatSessionSpeechInputController {
	browserSupported: boolean;
	enabled: boolean;
	selectedProvider: SpeechToTextProvider;
	configuredProvider: UserSpeechToTextProvider | null;
	recording: boolean;
	transcribing: boolean;
	level: number;
	statusText: string | null;
	statusTone: SpeechInputStatusTone | null;
	availabilityDescription: string;
	toggleRecording: () => void;
}

const canUseSpeechInput = (): boolean => {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.mediaDevices?.getUserMedia === "function" &&
		typeof MediaRecorder !== "undefined"
	);
};

const normalizeMimeType = (mimeType: string | null | undefined): string => {
	return mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
};

const getConfiguredProvider = (
	settings: UserSpeechToTextSettings,
): UserSpeechToTextProvider | null => {
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

const getAvailabilityDescription = (
	browserSupported: boolean,
	settings: UserSpeechToTextSettings,
	configuredProvider: UserSpeechToTextProvider | null,
): string => {
	if (!browserSupported) {
		return "This WebView does not expose microphone recording APIs, so speak-to-text is unavailable here.";
	}

	if (settings.activeProvider === "none") {
		return "Choose an AI provider to turn short microphone recordings into editable draft text.";
	}

	const providerLabel = getProviderLabel(settings.activeProvider);

	if (configuredProvider) {
		return `${providerLabel} is ready for push-to-talk transcription. New recordings are inserted into the current draft as plain text.`;
	}

	return `${providerLabel} is selected for speak-to-text, but it is not configured yet. Save its API key first.`;
};

const resolveRecorderMimeType = (): string | undefined => {
	for (const candidate of RECORDING_MIME_CANDIDATES) {
		if (typeof MediaRecorder.isTypeSupported !== "function") {
			return candidate;
		}

		if (MediaRecorder.isTypeSupported(candidate)) {
			return candidate;
		}
	}

	return undefined;
};

const stopMediaStream = (stream: MediaStream | null): void => {
	stream?.getTracks().forEach((track) => {
		track.stop();
	});
};

const encodeWav = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
	const bytesPerSample = 2;
	const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
	const view = new DataView(buffer);

	const writeString = (offset: number, value: string): void => {
		for (const [index, character] of Array.from(value).entries()) {
			view.setUint8(offset + index, character.charCodeAt(0));
		}
	};

	writeString(0, "RIFF");
	view.setUint32(4, 36 + samples.length * bytesPerSample, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeString(36, "data");
	view.setUint32(40, samples.length * bytesPerSample, true);

	let offset = 44;

	for (const sample of samples) {
		const normalizedSample = Math.max(-1, Math.min(1, sample));
		view.setInt16(
			offset,
			normalizedSample < 0
				? normalizedSample * 0x8000
				: normalizedSample * 0x7fff,
			true,
		);
		offset += bytesPerSample;
	}

	return buffer;
};

const mixDownToMono = (audioBuffer: AudioBuffer): Float32Array => {
	if (audioBuffer.numberOfChannels === 1) {
		return audioBuffer.getChannelData(0);
	}

	const mixed = new Float32Array(audioBuffer.length);

	for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
		const channelData = audioBuffer.getChannelData(channelIndex);

		for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
			mixed[sampleIndex] += channelData[sampleIndex] / audioBuffer.numberOfChannels;
		}
	}

	return mixed;
};

const convertBlobToWav = async (blob: Blob): Promise<Blob> => {
	if (typeof AudioContext === "undefined") {
		throw new Error(
			"This WebView cannot convert the recorded audio to WAV for the selected provider.",
		);
	}

	const audioContext = new AudioContext();

	try {
		const audioData = await blob.arrayBuffer();
		const decodedAudio = await audioContext.decodeAudioData(audioData.slice(0));
		const monoSamples = mixDownToMono(decodedAudio);
		const wavBuffer = encodeWav(monoSamples, decodedAudio.sampleRate);

		return new Blob([wavBuffer], { type: "audio/wav" });
	} finally {
		void audioContext.close().catch(() => undefined);
	}
};

const prepareAudioBlob = async (
	blob: Blob,
	provider: UserSpeechToTextProvider,
): Promise<Blob> => {
	if (provider !== "google") {
		return blob;
	}

	const mimeType = normalizeMimeType(blob.type);

	if (GOOGLE_SUPPORTED_MIME_TYPES.has(mimeType)) {
		return blob;
	}

	return convertBlobToWav(blob);
};

const convertBlobToBase64 = async (blob: Blob): Promise<string> => {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onerror = () => {
			reject(reader.error ?? new Error("Failed to read the recorded audio."));
		};

		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error("Failed to read the recorded audio."));
				return;
			}

			const encoded = reader.result.split(",")[1]?.trim();

			if (!encoded) {
				reject(new Error("Failed to encode the recorded audio."));
				return;
			}

			resolve(encoded);
		};

		reader.readAsDataURL(blob);
	});
};

const getRecordingErrorMessage = (error: unknown): string => {
	if (error instanceof DOMException) {
		switch (error.name) {
			case "NotAllowedError":
				return "Microphone access was denied. Allow microphone access and try again.";
			case "NotFoundError":
				return "No microphone was found for this device.";
			case "NotReadableError":
				return "The microphone is already in use by another app or could not be started.";
			case "OverconstrainedError":
				return "The requested microphone settings are not available on this device.";
			default:
				return error.message || "The microphone could not be started.";
		}
	}

	return error instanceof Error
		? error.message
		: "The microphone could not be started.";
};

export const useChatSessionSpeechInput = (
	options: UseChatSessionSpeechInputOptions,
): ChatSessionSpeechInputController => {
	const browserSupported = canUseSpeechInput();
	const configuredProvider = useMemo(() => {
		return getConfiguredProvider(options.settings);
	}, [options.settings]);
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const [statusText, setStatusText] = useState<string | null>(null);
	const [statusTone, setStatusTone] = useState<SpeechInputStatusTone | null>(
		null,
	);
	const [level, setLevel] = useState(0);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const audioContextRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const monitoringIntervalRef = useRef<number | null>(null);
	const recordingSessionIdRef = useRef<string>(options.activeSessionId);
	const recordingProviderRef = useRef<UserSpeechToTextProvider | null>(null);

	const availabilityDescription = useMemo(() => {
		return getAvailabilityDescription(
			browserSupported,
			options.settings,
			configuredProvider,
		);
	}, [browserSupported, configuredProvider, options.settings]);

	const clearMonitoring = useCallback((): void => {
		if (monitoringIntervalRef.current !== null) {
			window.clearInterval(monitoringIntervalRef.current);
			monitoringIntervalRef.current = null;
		}

		setLevel(0);
		analyserRef.current = null;

		if (audioContextRef.current) {
			void audioContextRef.current.close().catch(() => undefined);
			audioContextRef.current = null;
		}
	}, []);

	const startLevelMonitoring = useCallback(
		(stream: MediaStream): void => {
			clearMonitoring();

			if (typeof AudioContext === "undefined") {
				return;
			}

			try {
				const audioContext = new AudioContext();
				audioContextRef.current = audioContext;

				const analyser = audioContext.createAnalyser();
				analyser.fftSize = 1024;
				analyser.smoothingTimeConstant = 0.85;

				const source = audioContext.createMediaStreamSource(stream);
				source.connect(analyser);

				analyserRef.current = analyser;

				const analyserData = new Uint8Array(analyser.fftSize);

				monitoringIntervalRef.current = window.setInterval(() => {
					if (!analyserRef.current) {
						return;
					}

					analyserRef.current.getByteTimeDomainData(analyserData);

					let sumSquares = 0;

					for (const sample of analyserData) {
						const normalizedSample = sample / 128 - 1;
						sumSquares += normalizedSample * normalizedSample;
					}

					setLevel(Math.sqrt(sumSquares / analyserData.length));
				}, VOICE_LEVEL_MONITOR_INTERVAL_MS);
			} catch {
				clearMonitoring();
			}
		},
		[clearMonitoring],
	);

	const finalizeRecording = useCallback(async (): Promise<void> => {
		const recorder = recorderRef.current;
		const stream = streamRef.current;
		const provider = recordingProviderRef.current;

		if (!recorder || !stream || !provider) {
			return;
		}

		clearMonitoring();
		setRecording(false);
		setTranscribing(true);
		setStatusTone("info");
		setStatusText("Transcribing…");

		try {
			const recordedBlob = await new Promise<Blob>((resolve, reject) => {
				recorder.onstop = () => {
					const fallbackMimeType =
						normalizeMimeType(recorder.mimeType) || "audio/webm";
					const blob = new Blob(chunksRef.current, {
						type: fallbackMimeType,
					});

					resolve(blob);
				};
				recorder.onerror = () => {
					reject(recorder.error ?? new Error("Recording failed."));
				};

				recorder.stop();
			});

			stopMediaStream(stream);
			recorderRef.current = null;
			streamRef.current = null;
			chunksRef.current = [];

			await assertRecordedSpeechDetected(recordedBlob);
			const preparedBlob = await prepareAudioBlob(recordedBlob, provider);
			const transcription = await transcribeUserSpeechAudio({
				provider,
				audioBase64: await convertBlobToBase64(preparedBlob),
				mimeType: normalizeMimeType(preparedBlob.type) || "audio/wav",
			});
			const transcriptText = transcription.text.trim();

			if (!transcriptText) {
				throw new Error("No speech was detected in the recording.");
			}

			options.onTranscript(recordingSessionIdRef.current, transcriptText);
			setStatusTone("success");
			setStatusText("Transcript added to the draft.");
		} catch (error) {
			stopMediaStream(stream);
			recorderRef.current = null;
			streamRef.current = null;
			chunksRef.current = [];
			clearMonitoring();
			setStatusTone("error");
			setStatusText(
				error instanceof Error
					? error.message
					: "Speech-to-text failed for this recording.",
			);
		} finally {
			recordingProviderRef.current = null;
			setTranscribing(false);
		}
	}, [clearMonitoring, options]);

	const startRecording = useCallback(async (): Promise<void> => {
		if (!browserSupported) {
			setStatusTone("error");
			setStatusText(
				"This WebView does not expose microphone recording APIs.",
			);
			return;
		}

		if (!configuredProvider) {
			setStatusTone("info");
			setStatusText("Choose and configure a speak-to-text provider first.");
			return;
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: createSpeechInputAudioConstraints(
					options.settings.inputDeviceId,
				),
			});
			const recorderMimeType = resolveRecorderMimeType();
			const recorder = recorderMimeType
				? new MediaRecorder(stream, {
						mimeType: recorderMimeType,
						audioBitsPerSecond: 128_000,
					})
				: new MediaRecorder(stream);

			chunksRef.current = [];
			recorder.ondataavailable = (event: BlobEvent) => {
				if (event.data.size > 0) {
					chunksRef.current.push(event.data);
				}
			};
			startLevelMonitoring(stream);
			recorderRef.current = recorder;
			streamRef.current = stream;
			recordingSessionIdRef.current = options.activeSessionId;
			recordingProviderRef.current = configuredProvider;
			setStatusTone("info");
			setStatusText("Listening…");
			setRecording(true);
			recorder.start();
		} catch (error) {
			setStatusTone("error");
			setStatusText(getRecordingErrorMessage(error));
			setRecording(false);
			setTranscribing(false);
			recorderRef.current = null;
			clearMonitoring();
			stopMediaStream(streamRef.current);
			streamRef.current = null;
			chunksRef.current = [];
			recordingProviderRef.current = null;
		}
	}, [
		browserSupported,
		clearMonitoring,
		configuredProvider,
		options.activeSessionId,
		options.settings.inputDeviceId,
		startLevelMonitoring,
	]);

	const toggleRecording = useCallback((): void => {
		if (transcribing) {
			return;
		}

		if (recording) {
			void finalizeRecording();
			return;
		}

		void startRecording();
	}, [finalizeRecording, recording, startRecording, transcribing]);

	useEffect(() => {
		return () => {
			const recorder = recorderRef.current;

			if (recorder && recorder.state !== "inactive") {
				try {
					recorder.stop();
				} catch {
					// ignore cleanup failures during unmount
				}
			}

			clearMonitoring();
			stopMediaStream(streamRef.current);
			recorderRef.current = null;
			streamRef.current = null;
			chunksRef.current = [];
			recordingProviderRef.current = null;
		};
	}, [clearMonitoring]);

	return {
		browserSupported,
		enabled: configuredProvider !== null,
		selectedProvider: options.settings.activeProvider,
		configuredProvider,
		recording,
		transcribing,
		level,
		statusText,
		statusTone,
		availabilityDescription,
		toggleRecording,
	};
};
