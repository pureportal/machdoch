import {
  AlertTriangle,
  ArrowLeftRight,
  Brain,
  FileText,
  Folder,
  Gauge,
  KeyRound,
  LoaderCircle,
  Monitor,
  Network,
  Palette,
  Search as SearchIcon,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { cn } from "../../lib/utils";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsSectionGroup,
} from "../_helpers/session-shell";
import { AgentLimitsSettingsPanel } from "./settings-dialog-panels/agent-limits-settings-panel";
import { AppearanceSettingsPanel } from "./settings-dialog-panels/appearance-settings-panel";
import { DesktopSettingsPanel } from "./settings-dialog-panels/desktop-settings-panel";
import { InstructionSettingsPanel } from "./settings-dialog-panels/instruction-settings-panel";
import { MemorySettingsPanel } from "./settings-dialog-panels/memory-settings-panel";
import { McpSettingsPanel } from "./settings-dialog-panels/mcp-settings-panel";
import {
  SettingsNavigationGuardProvider,
  type SettingsNavigationGuardState,
} from "./settings-dialog-panels/navigation-guard";
import { ProviderSettingsPanel } from "./settings-dialog-panels/provider-settings-panel";
import { SettingsTransferPanel } from "./settings-dialog-panels/settings-transfer-panel";
import type {
  AgentLimitsSettingsControls,
  AppearanceSettingsControls,
  DesktopSettingsControls,
  InstructionSettingsControls,
  MemorySettingsControls,
  McpSettingsControls,
  ProviderSetupControls,
  VoiceSettingsControls,
  WebSearchSetupControls,
  WorkspaceSettingsControls,
} from "./settings-dialog-panels/types";
import { VoiceSettingsPanel } from "./settings-dialog-panels/voice-settings-panel";
import { WebSearchSettingsPanel } from "./settings-dialog-panels/web-search-settings-panel";
import { WorkspaceSettingsPanel } from "./settings-dialog-panels/workspace-settings-panel";

const SETTINGS_SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  providers: KeyRound,
  workspace: Folder,
  instructions: FileText,
  "web-search": SearchIcon,
  mcp: Network,
  agent: Gauge,
  appearance: Palette,
  voice: Volume2,
  memory: Brain,
  desktop: Monitor,
  transfer: ArrowLeftRight,
};

const SETTINGS_SECTION_GROUP_ORDER = [
  "Setup",
  "Agent",
  "Capabilities",
  "App",
  "Data",
] as const satisfies readonly SettingsSectionGroup[];

const INTRO_SECTION_ID = "__intro";

type SettingsDialogSectionId = SettingsSection | typeof INTRO_SECTION_ID;

interface SettingsDialogSectionDefinition {
  id: SettingsDialogSectionId;
  label: string;
  group: SettingsSectionGroup;
  description: string;
  keywords: readonly string[];
}

type PendingNavigation =
  | { target: "close"; guard: SettingsNavigationGuardState }
  | { target: "primary"; guard: SettingsNavigationGuardState }
  | {
      target: "section";
      section: SettingsDialogSectionId;
      guard: SettingsNavigationGuardState;
    };

export interface SettingsControlsProps {
  providerSetup: ProviderSetupControls;
  workspaceSetup: WorkspaceSettingsControls;
  instructionsSetup: InstructionSettingsControls;
  webSearchSetup: WebSearchSetupControls;
  mcpSetup: McpSettingsControls;
  agentLimitsSetup: AgentLimitsSettingsControls;
  appearanceSetup: AppearanceSettingsControls;
  memorySetup: MemorySettingsControls;
  desktopSetup: DesktopSettingsControls;
  voiceSetup: VoiceSettingsControls;
}

export interface SettingsDialogIntroSection {
  label: string;
  description: string;
  keywords: readonly string[];
  icon: LucideIcon;
  content: JSX.Element;
}

export interface SettingsDialogPrimaryAction {
  label: string;
  pendingLabel?: string;
  discardLabel?: string;
  disabled?: boolean;
  onAction: () => Promise<void> | void;
}

export interface SettingsDialogProps extends SettingsControlsProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
  onClose: () => Promise<void> | void;
  title?: string;
  description?: string;
  closeLabel?: string;
  closeText?: string;
  closeDiscardLabel?: string;
  introSection?: SettingsDialogIntroSection;
  primaryAction?: SettingsDialogPrimaryAction;
}

const renderSettingsPanel = ({
  settingsSection,
  providerSetup,
  workspaceSetup,
  instructionsSetup,
  webSearchSetup,
  mcpSetup,
  agentLimitsSetup,
  appearanceSetup,
  memorySetup,
  desktopSetup,
  voiceSetup,
}: SettingsDialogProps): JSX.Element => {
  switch (settingsSection) {
    case "providers":
      return <ProviderSettingsPanel setup={providerSetup} />;

    case "workspace":
      return <WorkspaceSettingsPanel setup={workspaceSetup} />;

    case "instructions":
      return <InstructionSettingsPanel setup={instructionsSetup} />;

    case "web-search":
      return <WebSearchSettingsPanel setup={webSearchSetup} />;

    case "mcp":
      return <McpSettingsPanel setup={mcpSetup} />;

    case "agent":
      return <AgentLimitsSettingsPanel setup={agentLimitsSetup} />;

    case "appearance":
      return <AppearanceSettingsPanel setup={appearanceSetup} />;

    case "memory":
      return <MemorySettingsPanel setup={memorySetup} />;

    case "desktop":
      return <DesktopSettingsPanel setup={desktopSetup} />;

    case "voice":
      return <VoiceSettingsPanel setup={voiceSetup} />;

    case "transfer":
      return <SettingsTransferPanel />;
  }
};

export const SettingsDialog = (props: SettingsDialogProps): JSX.Element => {
  const {
    settingsSection,
    onSettingsSectionChange,
    onClose,
    title = "Settings",
    description = "Configure how Machdoch looks, connects, and works.",
    closeLabel = "Close settings",
    closeText,
    closeDiscardLabel,
    introSection,
    primaryAction,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [introActive, setIntroActive] = useState(Boolean(introSection));
  const [navigationGuard, setNavigationGuard] =
    useState<SettingsNavigationGuardState | null>(null);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [primaryActionRunning, setPrimaryActionRunning] = useState(false);
  const [closeActionRunning, setCloseActionRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigationButtonRefs = useRef(
    new Map<SettingsDialogSectionId, HTMLButtonElement>(),
  );
  const pendingTriggerRef = useRef<HTMLElement | null>(null);
  const mobileSectionRef = useRef<HTMLSelectElement>(null);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationTitleId = useId();
  const confirmationDescriptionId = useId();
  const pendingGuard = pendingNavigation
    ? (navigationGuard ?? pendingNavigation.guard)
    : null;
  const dialogSections = useMemo<readonly SettingsDialogSectionDefinition[]>(
    () => {
      const introSections: readonly SettingsDialogSectionDefinition[] =
        introSection
          ? [
              {
                id: INTRO_SECTION_ID,
                label: introSection.label,
                group: "Setup",
                description: introSection.description,
                keywords: introSection.keywords,
              },
            ]
          : [];

      return [...introSections, ...SETTINGS_SECTIONS];
    },
    [introSection],
  );
  const activeSectionId =
    introSection && introActive ? INTRO_SECTION_ID : settingsSection;
  const activeSection =
    dialogSections.find((section) => section.id === activeSectionId) ??
    dialogSections[0];
  const ActiveSectionIcon =
    activeSection.id === INTRO_SECTION_ID
      ? (introSection?.icon ?? KeyRound)
      : SETTINGS_SECTION_ICONS[activeSection.id];
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleSections = useMemo(() => {
    if (!normalizedSearchQuery) {
      return dialogSections;
    }

    return dialogSections.filter((section) =>
      [section.label, section.description, ...section.keywords]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery),
    );
  }, [dialogSections, normalizedSearchQuery]);

  useEffect(() => {
    if (pendingNavigation) {
      stayButtonRef.current?.focus();
    }
  }, [pendingNavigation]);

  const runPrimaryAction = async (): Promise<void> => {
    if (
      !primaryAction ||
      primaryAction.disabled ||
      primaryActionRunning ||
      closeActionRunning
    ) {
      return;
    }

    setActionError(null);
    setPrimaryActionRunning(true);

    try {
      await primaryAction.onAction();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Setup could not be completed.",
      );
    } finally {
      setPrimaryActionRunning(false);
    }
  };

  const runCloseAction = async (): Promise<void> => {
    if (closeActionRunning || primaryActionRunning) {
      return;
    }

    setActionError(null);
    setCloseActionRunning(true);

    try {
      await onClose();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Settings could not be closed.",
      );
    } finally {
      setCloseActionRunning(false);
    }
  };

  const performNavigation = (
    target: PendingNavigation["target"],
    section?: SettingsDialogSectionId,
    restoreSectionFocus = false,
  ): void => {
    if (target === "close") {
      void runCloseAction();
      return;
    }

    if (target === "primary") {
      void runPrimaryAction();
      return;
    }

    if (section) {
      if (section === INTRO_SECTION_ID) {
        setIntroActive(true);
      } else {
        setIntroActive(false);
        onSettingsSectionChange(section);
      }

      if (restoreSectionFocus) {
        window.setTimeout(() => {
          const sectionButton = navigationButtonRefs.current.get(section);

          if (sectionButton?.isConnected) {
            sectionButton.focus();
            return;
          }

          mobileSectionRef.current?.focus();
        }, 0);
      }
    }
  };

  useEffect(() => {
    if (!pendingNavigation || navigationGuard || discarding) {
      return;
    }

    const completedNavigation = pendingNavigation;
    setPendingNavigation(null);
    pendingTriggerRef.current = null;
    performNavigation(
      completedNavigation.target,
      completedNavigation.target === "section"
        ? completedNavigation.section
        : undefined,
      completedNavigation.target === "section",
    );
  }, [discarding, navigationGuard, pendingNavigation]);

  const requestSectionChange = (section: SettingsDialogSectionId): void => {
    if (section === activeSectionId) {
      return;
    }

    if (navigationGuard) {
      pendingTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setNavigationError(null);
      setPendingNavigation({
        target: "section",
        section,
        guard: navigationGuard,
      });
      return;
    }

    performNavigation("section", section);
  };

  const requestPrimaryAction = (): void => {
    if (
      !primaryAction ||
      primaryAction.disabled ||
      primaryActionRunning ||
      closeActionRunning
    ) {
      return;
    }

    if (navigationGuard) {
      pendingTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setNavigationError(null);
      setPendingNavigation({ target: "primary", guard: navigationGuard });
      return;
    }

    void runPrimaryAction();
  };

  const requestClose = (): void => {
    if (closeActionRunning || primaryActionRunning) {
      return;
    }

    if (navigationGuard) {
      pendingTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setNavigationError(null);
      setPendingNavigation({ target: "close", guard: navigationGuard });
      return;
    }

    void runCloseAction();
  };

  const cancelPendingNavigation = (): void => {
    const trigger = pendingTriggerRef.current;
    pendingTriggerRef.current = null;
    setPendingNavigation(null);
    setNavigationError(null);
    window.setTimeout(() => {
      if (trigger?.isConnected) {
        trigger.focus();
      }
    }, 0);
  };

  const confirmNavigation = async (): Promise<void> => {
    if (!pendingNavigation || !pendingGuard || pendingGuard.canDiscard === false) {
      return;
    }

    setDiscarding(true);
    setNavigationError(null);

    try {
      await pendingGuard.onDiscard();
      const completedNavigation = pendingNavigation;
      setPendingNavigation(null);
      setNavigationGuard(null);
      pendingTriggerRef.current = null;
      performNavigation(
        completedNavigation.target,
        completedNavigation.target === "section"
          ? completedNavigation.section
          : undefined,
        completedNavigation.target === "section",
      );
    } catch (error) {
      setNavigationError(
        error instanceof Error
          ? error.message
          : "The current settings operation could not be stopped.",
      );
    } finally {
      setDiscarding(false);
    }
  };

  const handleNavigationKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    section: SettingsDialogSectionId,
  ): void => {
    const currentIndex = visibleSections.findIndex(
      (candidate) => candidate.id === section,
    );
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % visibleSections.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + visibleSections.length) % visibleSections.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visibleSections.length - 1;
    }

    if (nextIndex === null || visibleSections.length === 0) {
      return;
    }

    event.preventDefault();
    navigationButtonRefs.current.get(visibleSections[nextIndex].id)?.focus();
  };

  return (
    <DialogContent
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault();

        if (pendingNavigation && !discarding) {
          cancelPendingNavigation();
          return;
        }

        requestClose();
      }}
      onInteractOutside={(event) => {
        event.preventDefault();
        requestClose();
      }}
      className="app-settings-dialog h-[min(800px,calc(100dvh-24px))] max-h-none w-[min(1240px,calc(100vw-24px))] max-w-none gap-0 overflow-hidden rounded-2xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none"
    >
      <div
        inert={
          pendingNavigation || primaryActionRunning || closeActionRunning
            ? true
            : undefined
        }
        aria-hidden={pendingNavigation ? true : undefined}
        aria-busy={
          primaryActionRunning || closeActionRunning ? true : undefined
        }
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <DialogHeader className="min-h-16 flex-row items-center justify-between gap-4 border-b border-slate-800/80 px-5 py-2.5 pr-4 text-left">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-semibold tracking-tight text-white">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-xs text-slate-400">
              {description}
            </DialogDescription>
            {actionError ? (
              <p role="alert" className="mt-1 text-xs text-rose-300">
                {actionError}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {navigationGuard ? (
              <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                Changes pending
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              title={closeLabel}
              disabled={closeActionRunning || primaryActionRunning}
              onClick={requestClose}
              className="h-9 w-9 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="border-b border-slate-800/80 bg-slate-950/80 p-3 md:hidden">
          <label htmlFor="mobile-settings-section" className="sr-only">
            Settings section
          </label>
          <select
            ref={mobileSectionRef}
            id="mobile-settings-section"
            value={activeSectionId}
            onChange={(event) =>
              requestSectionChange(
                event.target.value as SettingsDialogSectionId,
              )
            }
            className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm font-medium text-slate-100 outline-none focus:border-sky-500/50 focus:ring-2 focus:ring-sky-500/20"
          >
            {SETTINGS_SECTION_GROUP_ORDER.map((group) => (
              <optgroup key={group} label={group}>
                {dialogSections.filter(
                  (section) => section.group === group,
                ).map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[13rem_minmax(0,1fr)]">
          <nav
            aria-label="Settings sections"
            className="hidden min-h-0 overflow-y-auto border-r border-slate-800/80 bg-slate-950/70 px-3 py-3 md:block"
          >
            <div className="relative mb-3">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
              />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label="Find settings"
                placeholder="Find settings"
                className="h-9 rounded-lg border-slate-800 bg-slate-950 pl-9 text-sm text-slate-100"
              />
            </div>

            {visibleSections.length === 0 ? (
              <div className="grid justify-items-start gap-2 px-2 py-3">
                <p className="text-sm text-slate-400">No settings found.</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSearchQuery("")}
                  className="-ml-2 text-sky-300 hover:bg-slate-900 hover:text-sky-200"
                >
                  Clear search
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {SETTINGS_SECTION_GROUP_ORDER.map((group) => {
                  const groupSections = visibleSections.filter(
                    (section) => section.group === group,
                  );

                  if (groupSections.length === 0) {
                    return null;
                  }

                  return (
                    <div key={group} className="grid gap-1">
                      <p className="px-3 pb-1 text-[0.6875rem] font-semibold tracking-[0.12em] text-slate-500 uppercase">
                        {group}
                      </p>
                      {groupSections.map((section) => {
                        const SectionIcon =
                          section.id === INTRO_SECTION_ID
                            ? (introSection?.icon ?? KeyRound)
                            : SETTINGS_SECTION_ICONS[section.id];
                        const selected = activeSectionId === section.id;

                        return (
                          <Button
                            key={section.id}
                            ref={(node) => {
                              if (node) {
                                navigationButtonRefs.current.set(
                                  section.id,
                                  node,
                                );
                              } else {
                                navigationButtonRefs.current.delete(section.id);
                              }
                            }}
                            type="button"
                            variant="ghost"
                            aria-current={selected ? "page" : undefined}
                            onKeyDown={(event) =>
                              handleNavigationKeyDown(event, section.id)
                            }
                            onClick={() => requestSectionChange(section.id)}
                            className={cn(
                              "h-8.5 w-full justify-start rounded-lg border border-transparent bg-transparent px-3 text-sm text-slate-400 hover:border-slate-800 hover:bg-slate-900/70 hover:text-slate-100",
                              selected &&
                                "border-sky-500/25 bg-sky-500/10 font-semibold text-sky-100",
                            )}
                          >
                            <SectionIcon className="size-4" />
                            <span className="truncate">{section.label}</span>
                          </Button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </nav>

          <ScrollArea
            key={activeSectionId}
            type="always"
            role="region"
            aria-labelledby="active-settings-section-title"
            className="min-h-0 bg-slate-950/40 [&_[data-slot=scroll-area-scrollbar]]:w-3 [&_[data-slot=scroll-area-scrollbar]]:border-l [&_[data-slot=scroll-area-scrollbar]]:border-l-slate-800 [&_[data-slot=scroll-area-scrollbar]]:bg-slate-950/80 [&_[data-slot=scroll-area-thumb]]:bg-slate-600/80 [&_[data-slot=scroll-area-thumb]]:hover:bg-slate-500"
          >
            <div className="mx-auto grid w-full max-w-5xl content-start gap-4 px-4 py-4 pr-7 sm:px-6 sm:py-5 sm:pr-9">
              <header className="flex items-start gap-3 border-b border-slate-800/70 pb-4">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-300">
                  <ActiveSectionIcon className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <h2
                    id="active-settings-section-title"
                    className="text-lg font-semibold tracking-tight text-slate-100"
                  >
                    {activeSection.label}
                  </h2>
                  <p className="mt-1 text-sm leading-5 text-slate-400">
                    {activeSection.description}
                  </p>
                </div>
              </header>

              <SettingsNavigationGuardProvider
                onGuardChange={setNavigationGuard}
              >
                {activeSectionId === INTRO_SECTION_ID && introSection
                  ? introSection.content
                  : renderSettingsPanel({
                      ...props,
                      settingsSection: activeSectionId as SettingsSection,
                    })}
              </SettingsNavigationGuardProvider>
            </div>
          </ScrollArea>
        </div>
        {primaryAction || closeText ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800/80 bg-slate-950/95 px-4 py-3 sm:px-5">
            <Button
              type="button"
              variant="outline"
              disabled={closeActionRunning || primaryActionRunning}
              onClick={requestClose}
              className="h-9 rounded-lg border-slate-700 bg-slate-900 px-4 text-slate-200 hover:bg-slate-800"
            >
              {closeActionRunning ? "Closing…" : (closeText ?? "Cancel")}
            </Button>
            {primaryAction ? (
              <Button
                type="button"
                disabled={
                  primaryAction.disabled ||
                  primaryActionRunning ||
                  closeActionRunning
                }
                aria-busy={primaryActionRunning}
                onClick={requestPrimaryAction}
                className="h-9 rounded-lg bg-sky-400 px-4 text-slate-950 hover:bg-sky-300"
              >
                {primaryActionRunning ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : null}
                {primaryActionRunning
                  ? (primaryAction.pendingLabel ?? `${primaryAction.label}…`)
                  : primaryAction.label}
              </Button>
            ) : null}
          </footer>
        ) : null}
      </div>

      {pendingNavigation && pendingGuard ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/75 p-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={confirmationTitleId}
            aria-describedby={confirmationDescriptionId}
            className="grid w-full max-w-md gap-4 rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl shadow-black/45"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-300">
                <AlertTriangle className="size-4.5" />
              </span>
              <div className="min-w-0">
                <h2 id={confirmationTitleId} className="font-semibold">
                  {pendingGuard.title}
                </h2>
                <p
                  id={confirmationDescriptionId}
                  className="mt-1 text-sm leading-6 text-slate-300"
                >
                  {pendingGuard.description}
                </p>
              </div>
            </div>

            {navigationError ? (
              <p
                role="alert"
                className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
              >
                {navigationError}
              </p>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                ref={stayButtonRef}
                type="button"
                variant="ghost"
                disabled={discarding}
                onClick={cancelPendingNavigation}
                className="text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                Stay here
              </Button>
              {pendingGuard.canDiscard !== false ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={discarding}
                  onClick={() => void confirmNavigation()}
                >
                  {discarding ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : null}
                  {discarding
                    ? "Finishing…"
                    : pendingNavigation.target === "primary"
                      ? (primaryAction?.discardLabel ??
                        "Discard changes and finish")
                      : pendingNavigation.target === "close" &&
                          closeDiscardLabel
                        ? closeDiscardLabel
                      : (pendingGuard.confirmLabel ?? "Discard changes")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </DialogContent>
  );
};
