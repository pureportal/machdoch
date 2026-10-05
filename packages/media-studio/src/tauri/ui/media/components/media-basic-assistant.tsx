import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import type {
  MediaAssetRecord,
  MediaModelCatalogSnapshot,
} from "../../../../core/media/contracts.js";
import {
  createMediaFlowAgentRequest,
  type MediaFlowAgentResult,
} from "../../../../core/media/flow-agent.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { hasMediaHost, invoke } from "../media-platform";
import {
  basicAssistantDraftIdentity,
  createBasicAssistantFlow,
  readBasicAssistantDraft,
  type MediaBasicAssistantDraft,
} from "../media-basic-assistant";

interface MediaBasicAssistantProps {
  workspaceRoot: string | null;
  draft: MediaBasicAssistantDraft;
  catalog: MediaModelCatalogSnapshot;
  assets: readonly MediaAssetRecord[];
  onApply: (draft: MediaBasicAssistantDraft) => void;
}

export function MediaBasicAssistant(props: MediaBasicAssistantProps) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const sequence = useRef(0);
  const busy = useRef(false);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );
  const supported = hasMediaHost();

  const changeOpen = (value: boolean) => {
    sequence.current += 1;
    busy.current = false;
    setPending(false);
    setMessage(null);
    setOpen(value);
  };

  const submit = async () => {
    if (busy.current || !supported || !prompt.trim()) return;
    const current = props;
    const identity = basicAssistantDraftIdentity(current.draft);
    const requestSequence = ++sequence.current;
    busy.current = true;
    setPending(true);
    setMessage(null);
    try {
      const request = createMediaFlowAgentRequest({
        prompt: `Fill the Basic ${current.draft.target} fields for this request: ${prompt.trim()}\nKeep the current media type and node/connection IDs. Update only settings representable by this recipe. Synchronize generation and output settings. Do not add arbitrary workflow operations or generate pose maps. Return graphJson null and explain if the request needs Advanced mode or unavailable capabilities.`,
        flow: createBasicAssistantFlow(current.draft, current.catalog.models),
        messages: [],
        models: current.catalog.models,
        addons: current.catalog.addons,
        assets: current.assets,
      });
      const result = await invoke<MediaFlowAgentResult>(
        "run_media_flow_agent",
        { workspaceRoot: current.workspaceRoot, request },
      );
      if (sequence.current !== requestSequence) return;
      if (
        latest.current.workspaceRoot !== current.workspaceRoot ||
        basicAssistantDraftIdentity(latest.current.draft) !== identity
      )
        throw new Error(
          "The settings changed while the assistant was working. Try again with the latest settings.",
        );
      if (!Array.isArray(result.poseMaps) || result.poseMaps.length)
        throw new Error(
          "Create poses with the flow assistant in Advanced mode.",
        );
      if (!result.flow) {
        setMessage(result.message);
        return;
      }
      const updated = readBasicAssistantDraft(
        result.flow,
        current.draft,
        latest.current.catalog.models,
      );
      latest.current.onApply(updated);
      setPrompt("");
      changeOpen(false);
    } catch (error) {
      if (sequence.current === requestSequence)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (sequence.current === requestSequence) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={!supported}
        onClick={() => changeOpen(true)}
      >
        <Sparkles className="h-4 w-4" />
        Assistant
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Fill settings</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Textarea
              aria-label="Describe what to create"
              value={prompt}
              maxLength={14000}
              disabled={pending}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
            />
            {message ? (
              <p role="alert" className="text-sm text-slate-300">
                {message}
              </p>
            ) : null}
            <Button type="submit" disabled={pending || !prompt.trim()}>
              {pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {pending ? "Filling settings…" : "Fill settings"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
