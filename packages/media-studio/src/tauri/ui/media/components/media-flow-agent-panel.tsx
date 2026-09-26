import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Send, X } from "lucide-react";
import type {
  MediaAssetRecord,
  MediaAssetImportResult,
  MediaFlow,
  MediaModelAddonDescriptor,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import type {
  MediaFlowAgentMessage,
  MediaFlowAgentRequest,
  MediaFlowAgentResult,
} from "../../../../core/media/flow-agent.js";
import { createMediaFlowDocumentDigest } from "../../../../core/media/canonicalize.js";
import { hasMediaHost, invoke } from "../media-platform";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";

interface MediaFlowAgentPanelProps {
  open: boolean;
  workspaceRoot: string | null;
  flow: MediaFlow;
  models: readonly MediaModelDescriptor[];
  addons: readonly MediaModelAddonDescriptor[];
  assets: readonly MediaAssetRecord[];
  onApply: (flow: MediaFlow) => void;
  onPoseAssetsCreated: (assets: MediaAssetRecord[]) => void;
  onClose: () => void;
}

export function MediaFlowAgentPanel(props: MediaFlowAgentPanelProps) {
  const { open, flow, models, addons, assets, workspaceRoot, onClose } = props;
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<MediaFlowAgentMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const requestSequence = useRef(0);
  const busy = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      requestSequence.current += 1;
    },
    [],
  );
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages, pending, open]);
  const supported = hasMediaHost();

  const submit = async () => {
    const content = prompt.trim();
    if (!content || busy.current || !supported) return;
    busy.current = true;
    const sequence = ++requestSequence.current;
    const digest = createMediaFlowDocumentDigest(flow);
    const request: MediaFlowAgentRequest = {
      prompt: content,
      flow,
      messages: messages.slice(-40),
      models: models.map(
        ({
          id,
          displayName,
          target,
          installed,
          configured,
          architecture,
          capabilities,
        }) => ({
          id,
          displayName,
          target,
          installed,
          configured,
          architecture,
          capabilities,
        }),
      ),
      addons: addons.map(
        ({
          id,
          displayName,
          kind,
          architecture,
          triggerWords,
          defaultToken,
        }) => ({
          id,
          displayName,
          kind,
          architecture,
          triggerWords,
          defaultToken,
        }),
      ),
      assets: assets.map(({ id, kind, width, height }) => ({
        id,
        kind,
        width,
        height,
      })),
    };
    setPending(true);
    setError(null);
    try {
      const result = await invoke<MediaFlowAgentResult>(
        "run_media_flow_agent",
        { workspaceRoot, request },
      );
      if (sequence !== requestSequence.current) return;
      if (
        latest.current.workspaceRoot !== workspaceRoot ||
        createMediaFlowDocumentDigest(latest.current.flow) !== digest
      ) {
        throw new Error(
          "The flow changed while the assistant was working. Send your request again to use the latest flow.",
        );
      }
      if (!Array.isArray(result.poseMaps))
        throw new Error("The flow assistant returned an invalid pose response. Send your request again.");
      if (result.flow) {
        const generated = await Promise.all(
          result.poseMaps.map(async ({ id, map }) => ({
            id,
            asset: (await invoke<MediaAssetImportResult>("media_create_pose_map", { map })).asset,
          })),
        );
        if (sequence !== requestSequence.current) return;
        if (
          latest.current.workspaceRoot !== workspaceRoot ||
          createMediaFlowDocumentDigest(latest.current.flow) !== digest
        ) {
          throw new Error("The flow changed while the assistant was working. Send your request again to use the latest flow.");
        }
        if (generated.length) latest.current.onPoseAssetsCreated(generated.map((entry) => entry.asset));
        const assetsById = new Map(generated.map((entry) => [`pose-map:${entry.id}`, entry.asset.id]));
        latest.current.onApply({
          ...result.flow,
          nodes: result.flow.nodes.map((node) =>
            node.type === "source.image" && assetsById.has(String(node.config.assetId ?? ""))
              ? { ...node, config: { ...node.config, assetId: assetsById.get(String(node.config.assetId)) } }
              : node,
          ),
        });
      }
      setMessages((current) => [
        ...current,
        { role: "user", content },
        { role: "assistant", content: result.message },
      ]);
      setPrompt("");
    } catch (failure) {
      if (sequence === requestSequence.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (sequence === requestSequence.current) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  return (
    <aside
      hidden={!open}
      aria-label="Flow assistant"
      className={
        open
          ? "absolute inset-y-0 right-0 z-20 flex min-h-0 w-full max-w-[360px] flex-col border-l border-slate-800 bg-slate-950 shadow-2xl xl:static xl:max-w-none xl:shadow-none"
          : "hidden"
      }
    >
      <div className="flex items-center justify-between border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-100">Flow assistant</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close flow assistant"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm"
      >
        {messages.map((message, index) => (
          <div
            key={index}
            className={
              message.role === "user"
                ? "ml-6 whitespace-pre-wrap rounded-xl bg-slate-800 p-3 text-slate-100"
                : "whitespace-pre-wrap text-slate-300"
            }
          >
            {message.content}
          </div>
        ))}
        {pending ? (
          <div role="status" className="flex items-center gap-2 text-slate-400">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Editing flow…
          </div>
        ) : null}
        <div ref={end} />
      </div>
      <form
        className="space-y-3 border-t border-slate-800 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!supported ? (
          <p className="text-xs text-slate-400">
            Connect to a client to use the flow assistant.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-xs text-rose-300">
            {error}
          </p>
        ) : null}
        <Textarea
          aria-label="Message the flow assistant"
          placeholder="Describe a flow or a change…"
          value={prompt}
          maxLength={16000}
          disabled={pending || !supported}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          className="min-h-24 resize-none"
        />
        <Button
          type="submit"
          disabled={pending || !supported || !prompt.trim()}
          className="w-full"
        >
          <Send className="h-4 w-4" />
          Send
        </Button>
      </form>
    </aside>
  );
}
