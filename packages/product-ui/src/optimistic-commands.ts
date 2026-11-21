import type {
  ProductCommand,
  ProductShell,
  ProductSnapshot,
} from "@machdoch/fleet-protocol";

type Composer = NonNullable<ProductShell["composer"]>;
type Session = ProductShell["sessions"][number];
export type OptimisticUpdate = (snapshot: ProductSnapshot) => ProductSnapshot;

function sessionUpdate(
  sessionId: string,
  changeComposer: (composer: Composer) => Composer,
  changeSession: (session: Session) => Session = (session) => session,
): OptimisticUpdate {
  return (snapshot) => {
    const shell = snapshot.shell;
    if (!shell) return snapshot;
    const composer =
      shell.composer?.sessionId === sessionId
        ? changeComposer(shell.composer)
        : shell.composer;
    return {
      ...snapshot,
      shell: {
        ...shell,
        sessions: shell.sessions.map((session) =>
          session.id === sessionId ? changeSession(session) : session,
        ),
        ...(composer ? { composer } : {}),
      },
    };
  };
}

function withoutMode({ mode: _mode, ...session }: Session): Session {
  return session;
}

function withoutReasoning({
  reasoning: _reasoning,
  ...session
}: Session): Session {
  return session;
}

export function optimisticUpdate(
  command: ProductCommand,
): OptimisticUpdate | null {
  switch (command.kind) {
    case "set-session-model":
      return sessionUpdate(
        command.sessionId,
        (composer) => {
          const provider = composer.modelCatalog.find(
            (entry) => entry.provider === command.provider,
          );
          const model = provider?.models.find(
            (entry) => entry.id === command.model,
          );
          return {
            ...composer,
            provider: command.provider,
            providerLabel: provider?.label ?? command.provider,
            model: command.model,
            modelLabel: model?.label ?? command.model,
            reasoningOptions: model?.reasoningOptions ?? composer.reasoningOptions,
          };
        },
        (session) => ({
          ...session,
          provider: command.provider,
          model: command.model,
        }),
      );
    case "set-session-mode":
      return sessionUpdate(
        command.sessionId,
        (composer) => ({ ...composer, mode: command.mode }),
        (session) => ({ ...session, mode: command.mode }),
      );
    case "clear-session-mode":
      return sessionUpdate(
        command.sessionId,
        (composer) => ({ ...composer, mode: composer.defaultMode }),
        withoutMode,
      );
    case "set-session-reasoning":
      return sessionUpdate(
        command.sessionId,
        (composer) => ({ ...composer, reasoning: command.reasoning }),
        (session) => ({ ...session, reasoning: command.reasoning }),
      );
    case "clear-session-reasoning":
      return sessionUpdate(
        command.sessionId,
        (composer) => ({ ...composer, reasoning: composer.defaultReasoning }),
        withoutReasoning,
      );
    case "set-prompt-enhancement-mode":
      return sessionUpdate(command.sessionId, (composer) => ({
        ...composer,
        promptEnhancementMode: command.promptEnhancementMode,
      }));
    case "set-interview":
      return sessionUpdate(command.sessionId, (composer) => ({
        ...composer,
        interviewEnabled: command.enabled,
      }));
    case "set-session-memory":
      return sessionUpdate(command.sessionId, (composer) => ({
        ...composer,
        sessionMemoryEnabled: command.enabled,
      }));
    case "set-workspace-memory":
      return sessionUpdate(command.sessionId, (composer) => ({
        ...composer,
        workspaceMemoryEnabled: command.enabled,
      }));
    case "set-global-memory":
      return sessionUpdate(command.sessionId, (composer) => ({
        ...composer,
        globalMemoryEnabled: command.enabled,
      }));
    case "set-ui-control":
      return sessionUpdate(command.sessionId, (composer) => ({
        ...composer,
        uiControlEnabled: command.enabled,
      }));
    case "submit-message":
      return (snapshot) => {
        const shell = snapshot.shell;
        const composer = shell?.composer;
        if (
          !shell ||
          !composer ||
          composer.sessionId !== command.sessionId ||
          shell.activeSessionId !== command.sessionId ||
          composer.isExecuting ||
          composer.promptEnhancementMode !== "off" ||
          composer.interviewEnabled ||
          command.prompt.startsWith("/")
        )
          return snapshot;
        return {
          ...snapshot,
          shell: {
            ...shell,
            visibleMessages: [
              ...shell.visibleMessages,
              {
                id: `pending-${command.commandId}`,
                role: "user",
                content: command.prompt,
                presentation: "message",
                attachments: composer.attachments,
                actions: {
                  canRetry: false,
                  canContinue: false,
                  canSaveAsContextPack: false,
                  canSpeak: false,
                  isSpeaking: false,
                },
              },
            ],
          },
        };
      };
    default:
      return null;
  }
}

export interface CachedSessionView {
  visibleMessages: ProductShell["visibleMessages"];
  composer: Composer | undefined;
}

export function activateCachedSession(
  sessionId: string,
  cached: CachedSessionView,
): OptimisticUpdate {
  return (snapshot) => {
    const shell = snapshot.shell;
    if (!shell?.sessions.some((session) => session.id === sessionId))
      return snapshot;
    const { composer: _composer, ...rest } = shell;
    return {
      ...snapshot,
      shell: {
        ...rest,
        activeSessionId: sessionId,
        visibleMessages: cached.visibleMessages,
        ...(cached.composer ? { composer: cached.composer } : {}),
      },
    };
  };
}
