import { createRoot } from "react-dom/client";
import { McpAppResults } from "@machdoch/client-ui/mcp-apps/results";
import { McpAppsSettings } from "@machdoch/client-ui/mcp-apps/settings";
import { connectLiveTranscription } from "../../../../packages/client-ui/src/voice/live-connection";
import { startLiveVoiceCapture } from "../../../../packages/client-ui/src/voice/live-capture";
import type { LiveVoiceSession } from "@machdoch/fleet-protocol/live-voice";
import type { McpAppInvoke } from "@machdoch/client-ui/mcp-apps/host";
import { createFleetOperationTransport } from "@machdoch/product-ui/fleet-operation-transport";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import {
  workspaceRequestSchema,
  instructionRequestSchema,
} from "@machdoch/fleet-protocol";
import { configureRemoteInstructionPlatform } from "../../src/tauri/ui/instruction-management/instruction-platform";
import { SkillLibraryPanel } from "../../src/tauri/ui/instruction-management/skill-library-panel";
import { WorkspaceLibraryView } from "../../src/tauri/ui/workspace-management/workspace-library-view";
import { configureRemoteWorkspacePlatform } from "../../src/tauri/ui/workspace-management/workspace-platform";

declare global {
  interface Window {
    verification: {
      root: string;
      appIds: string[];
      instanceId: string;
      stallNextApp?: boolean;
    };
    transcribe: (
      session: LiveVoiceSession,
      audio: string,
    ) => Promise<{
      text: string;
      speechStarts: number;
      audioChunks: number;
    }>;
  }
}

const basePath = `/api/instances/${window.verification.instanceId}/product`;
const transport = createFleetOperationTransport((request) =>
  api(`${basePath}/workspace`, {
    method: "POST",
    body: jsonBody(workspaceRequestSchema.parse(request)),
  }),
);
configureRemoteInstructionPlatform(
  createFleetOperationTransport((request) =>
    api(`${basePath}/instructions`, {
      method: "POST",
      body: jsonBody(instructionRequestSchema.parse(request)),
    }),
  ),
);
const invoke: McpAppInvoke = async <T,>(
  root: string,
  input: { action: string },
) => {
  const result = await transport.invoke<T>("run_mcp_app_command", {
    workspaceRoot: root,
    input,
  });
  if (input.action === "load" && window.verification.stallNextApp) {
    window.verification.stallNextApp = false;
    return { ...result, html: "<h1>Startup fixture</h1>" };
  }
  return result;
};
configureRemoteWorkspacePlatform(transport, async () => {});

window.transcribe = async (session, audio) => {
  const controller = new AbortController();
  const context = new AudioContext({ sampleRate: session.sampleRate });
  const microphone = context.createMediaStreamDestination();
  const source = context.createBufferSource();
  const binary = atob(audio);
  const buffer = context.createBuffer(
    1,
    binary.length / 2 + session.sampleRate,
    session.sampleRate,
  );
  const samples = buffer.getChannelData(0);
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const pcm = new DataView(bytes.buffer);
  for (let index = 0; index < binary.length / 2; index++)
    samples[index] = pcm.getInt16(index * 2, true) / 32768;
  source.buffer = buffer;
  source.connect(microphone);
  const getUserMedia = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => microphone.stream;
  let speechStarts = 0;
  let audioChunks = 0;
  const timeout = setTimeout(
    () => controller.abort(new Error("OpenAI transcription timed out.")),
    45_000,
  );
  try {
    const text = await new Promise<string>((resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
      void connectLiveTranscription(session, {
        signal: controller.signal,
        onPartial: () => {},
        onTranscript: resolve,
        onError: reject,
      })
        .then(async (connection) => {
          await startLiveVoiceCapture({
            signal: controller.signal,
            sampleRate: session.sampleRate,
            onSpeechStart: () => {
              speechStarts++;
              connection.start();
            },
            onAudio: (chunk) => {
              audioChunks++;
              connection.append(chunk);
            },
            onSpeechEnd: connection.commit,
            onError: reject,
          });
          await context.resume();
          source.start();
        })
        .catch(reject);
    });
    return { text, speechStarts, audioChunks };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    navigator.mediaDevices.getUserMedia = getUserMedia;
    microphone.stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
};

createRoot(document.getElementById("root")!).render(
  <>
    <McpAppsSettings invoke={invoke} />
    <McpAppResults
      appIds={window.verification.appIds}
      workspaceRoot={window.verification.root}
      invoke={invoke}
    />
    <WorkspaceLibraryView
      roots={[window.verification.root]}
      workspaceRoot={window.verification.root}
      onWorkspaceChange={() => {}}
      onDirtyChange={() => {}}
    />
    <SkillLibraryPanel />
  </>,
);
