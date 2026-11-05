import { Eraser, Maximize2, Sparkles, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, type JSX } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { AgentComposer } from "@machdoch/client-ui/composer/agent-composer";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { useAppControlLocation } from "@machdoch/media-studio/tauri/ui/app-control/use-app-control.js";
import type { useChatSessionController } from "../chat-session/_helpers/use-chat-session-controller";
import { SessionModelPicker } from "../chat-session/components/session-model-picker";
import { QuickChatConversation } from "./quick-chat-conversation";

type ChatSessionController = ReturnType<typeof useChatSessionController>;

export interface QuickChatPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quickTask: ChatSessionController["quickTask"];
  composer: ChatSessionController["quickTaskComposer"];
  focusRequest: number;
  onClearHistory: () => void;
  onOpenInChat: () => void;
  onOpenAttachment: (attachment: ChatSessionContextAttachment) => void;
}

export const QuickChatPanel = ({
  open,
  onOpenChange,
  quickTask,
  composer,
  focusRequest,
  onClearHistory,
  onOpenInChat,
  onOpenAttachment,
}: QuickChatPanelProps): JSX.Element => {
  const location = useAppControlLocation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  const running = quickTask.status === "running";
  const sessionKey = quickTask.session?.id ?? "quick-chat";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            textareaRef.current?.focus({ preventScroll: true });
          }}
          onInteractOutside={(event) => event.preventDefault()}
          className="app-quick-chat-panel fixed top-12 right-3 z-40 flex h-[min(42rem,calc(100dvh-4rem))] w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/95 text-slate-100 shadow-2xl shadow-black/50 backdrop-blur-xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-slate-900 py-2 pr-2 pl-3.5">
            <Sparkles
              aria-hidden="true"
              className="size-4 shrink-0 text-sky-400"
            />
            <div className="grid min-w-0 flex-1">
              <DialogPrimitive.Title className="text-sm leading-5 font-semibold">
                Quick Chat
              </DialogPrimitive.Title>
              {location.length > 0 ? (
                <p
                  aria-label="Current view"
                  title={location.join(" › ")}
                  className="truncate text-[11px] leading-4 text-slate-500"
                >
                  {location.join(" › ")}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open Quick Chat in Chat"
              tooltip="Open in Chat"
              disabled={!quickTask.session}
              onClick={onOpenInChat}
              className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <Maximize2 className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear Quick Chat history"
              tooltip="Clear history"
              disabled={!quickTask.canClearHistory}
              onClick={onClearHistory}
              className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <Eraser className="size-4" />
            </Button>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close Quick Chat"
                className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </header>

          <QuickChatConversation
            sessionId={sessionKey}
            messages={quickTask.visibleMessages}
            workspaceRoot={quickTask.workspaceRoot}
            running={running}
            onOpenWorkspaceFile={(relativePath, line) =>
              quickTask.onOpenWorkspaceFile(relativePath, line)
            }
            onOpenLocalFile={quickTask.onOpenLocalFile}
            onOpenAttachment={onOpenAttachment}
            onPickSuggestion={(suggestion) => {
              composer.onDraftChange(suggestion);
              textareaRef.current?.focus({ preventScroll: true });
            }}
            onSendSuggestion={(suggestion) => composer.onSend(suggestion)}
          />

          <footer className="shrink-0 border-t border-slate-900 p-3">
            <AgentComposer
              variant="quick"
              draftIdentity={`quick-chat:${sessionKey}`}
              textareaRef={textareaRef}
              draft={composer.draft}
              draftRevision={composer.draftRevision}
              textareaLabel="Quick Chat message"
              placeholder="Ask Machdoch"
              modelPicker={
                <SessionModelPicker
                  chooserProviders={composer.chooserProviders}
                  activeProvider={composer.provider}
                  activeModel={composer.model}
                  onSessionModelSelection={composer.onModelSelection}
                  registerCommand={false}
                />
              }
              contextAttachments={composer.contextAttachments}
              imageInputSupported={composer.imageInputSupported}
              imageInputDisabledReason={composer.imageInputDisabledReason}
              canSend={composer.canSend}
              sendDisabledReason={composer.sendDisabledReason}
              isExecuting={composer.isExecuting}
              toggles={[
                {
                  id: "machdoch",
                  label: "Machdoch mode",
                  icon: <WandSparkles className="h-3.5 w-3.5" />,
                  pressed: composer.autopilotEnabled,
                  onPressedChange: composer.onAutopilotChange,
                  activeClassName:
                    "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
                },
              ]}
              onSelectContextFiles={composer.onSelectContextFiles}
              onSelectContextFolders={composer.onSelectContextFolders}
              onSelectContextImages={composer.onSelectContextImages}
              onPasteContextImages={composer.onPasteContextImages}
              onOpenContextAttachment={composer.onOpenContextAttachment}
              onRemoveContextAttachment={composer.onRemoveContextAttachment}
              onClearContextAttachments={composer.onClearContextAttachments}
              onDraftChange={composer.onDraftChange}
              onSend={(draft) => composer.onSend(draft)}
              onCancel={composer.onCancel}
            />
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
