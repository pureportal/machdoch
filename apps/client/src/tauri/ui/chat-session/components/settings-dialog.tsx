import {
  AlertTriangle,
  ArrowLeftRight,
  Brain,
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
import { ScrollArea } from "../../components/ui/scroll-area";
import { SearchField } from "../../components/ui/search-field";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "../../commands/command-types";
import { cn } from "../../lib/utils";
import { getProviderLabel } from "../../model-catalog";
import {
  getUserApiKeyProviderLabel,
  MCP_CONFIG_SCOPE_OPTIONS,
  USER_API_KEY_PROVIDER_ORDER,
  USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
  USER_VOICE_AI_PROVIDER_ORDER,
  USER_WEB_SEARCH_PROVIDER_ORDER,
} from "../../runtime";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  REASONING_LABELS,
} from "../../reasoning-options";
import {
  getWebSearchProviderLabel,
  RUN_MODE_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsSectionGroup,
} from "../_helpers/session-shell";
import { AgentLimitsSettingsPanel } from "./settings-dialog-panels/agent-limits-settings-panel";
import { AppearanceSettingsPanel } from "./settings-dialog-panels/appearance-settings-panel";
import { DesktopSettingsPanel } from "./settings-dialog-panels/desktop-settings-panel";
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
  const dialogSections = useMemo<
    readonly SettingsDialogSectionDefinition[]
  >(() => {
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
  }, [introSection]);
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
    if (
      !pendingNavigation ||
      !pendingGuard ||
      pendingGuard.canDiscard === false
    ) {
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

  const settingsCommandStateRef = useRef({
    props,
    dialogSections,
    activeSectionId,
    searchQuery,
    pendingNavigation,
    pendingGuard,
    discarding,
    primaryAction,
    primaryActionRunning,
    closeActionRunning,
    requestSectionChange,
    requestPrimaryAction,
    requestClose,
    cancelPendingNavigation,
    confirmNavigation,
    setSearchQuery,
  });
  settingsCommandStateRef.current = {
    props,
    dialogSections,
    activeSectionId,
    searchQuery,
    pendingNavigation,
    pendingGuard,
    discarding,
    primaryAction,
    primaryActionRunning,
    closeActionRunning,
    requestSectionChange,
    requestPrimaryAction,
    requestClose,
    cancelPendingNavigation,
    confirmNavigation,
    setSearchQuery,
  };
  const settingsCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = { kind: "overlay" as const, ownerId: "settings-dialog" };
    const state = () => settingsCommandStateRef.current;
    const active = (section: SettingsSection): boolean =>
      state().activeSectionId === section;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9
        ? (`${index + 1}` as CommandPageItem["numericKey"])
        : index === 9
          ? "0"
          : undefined;
    return asPaletteCommands([
      {
        id: "settings.section.select",
        title: "Choose settings section",
        group: "Settings",
        scope,
        availability: () =>
          state().pendingNavigation
            ? {
                state: "disabled",
                reason: "Resolve the pending settings change first.",
              }
            : { state: "enabled" },
        children: () => ({
          id: "settings.section.select.page",
          title: "Choose settings section",
          searchPlaceholder: "Search settings sections",
          numericSelection: true,
          groups: SETTINGS_SECTION_GROUP_ORDER.map((group) => ({
            id: group.toLowerCase(),
            label: group,
            items: state()
              .dialogSections.filter((section) => section.group === group)
              .map((section, index, groupSections) => {
                const absoluteIndex = state().dialogSections.findIndex(
                  (candidate) => candidate.id === section.id,
                );
                return {
                  id: section.id,
                  title: section.label,
                  keywords: [section.description, ...section.keywords],
                  current: state().activeSectionId === section.id,
                  numericKey: numericKey(
                    absoluteIndex >= 0
                      ? absoluteIndex
                      : index + groupSections.length,
                  ),
                  execute: () => state().requestSectionChange(section.id),
                };
              }),
          })),
        }),
      },
      {
        id: "settings.search.clear",
        title: "Clear settings search",
        group: "Settings",
        scope,
        availability: () =>
          state().searchQuery ? { state: "enabled" } : { state: "hidden" },
        execute: () => state().setSearchQuery(""),
      },
      {
        id: "settings.primary.run",
        title: "Complete settings action",
        group: "Settings",
        scope,
        availability: () => {
          const current = state();
          if (!current.primaryAction) return { state: "hidden" };
          return current.primaryAction.disabled ||
            current.primaryActionRunning ||
            current.closeActionRunning
            ? {
                state: "disabled",
                reason: "The settings action is unavailable.",
              }
            : { state: "enabled" };
        },
        execute: () => state().requestPrimaryAction(),
      },
      {
        id: "settings.close",
        title: "Close settings",
        group: "Settings",
        scope,
        availability: () =>
          state().primaryActionRunning || state().closeActionRunning
            ? { state: "disabled", reason: "A settings action is in progress." }
            : { state: "enabled" },
        execute: () => state().requestClose(),
      },
      {
        id: "settings.navigation.stay",
        title: "Keep editing current settings",
        group: "Settings",
        scope,
        availability: () =>
          state().pendingNavigation && !state().discarding
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().cancelPendingNavigation(),
      },
      {
        id: "settings.navigation.discard",
        title: "Discard settings changes and continue",
        group: "Settings",
        scope,
        availability: () =>
          state().pendingNavigation &&
          state().pendingGuard?.canDiscard !== false
            ? state().discarding
              ? { state: "disabled", reason: "Discard is in progress." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => void state().confirmNavigation(),
      },
      {
        id: "settings.providers.select",
        title: "Choose model provider key",
        group: "Settings: Providers",
        scope,
        availability: () =>
          active("providers")
            ? state().props.providerSetup.loading ||
              state().props.providerSetup.saving
              ? { state: "disabled", reason: "Provider settings are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "settings.providers.select.page",
          title: "Choose model provider key",
          searchPlaceholder: "Search providers",
          numericSelection: true,
          groups: [
            {
              id: "providers",
              items: USER_API_KEY_PROVIDER_ORDER.map((provider, index) => ({
                id: provider,
                title: getUserApiKeyProviderLabel(provider),
                current: state().props.providerSetup.provider === provider,
                numericKey: numericKey(index),
                execute: () =>
                  state().props.providerSetup.onProviderChange(provider),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.providers.save",
        title: "Save model provider key",
        group: "Settings: Providers",
        scope,
        availability: () =>
          !active("providers")
            ? { state: "hidden" }
            : state().props.providerSetup.loading ||
                state().props.providerSetup.saving
              ? { state: "disabled", reason: "Provider settings are busy." }
              : { state: "enabled" },
        execute: () =>
          void state().props.providerSetup.onSave(
            state().props.providerSetup.keyValue,
          ),
      },
      {
        id: "settings.providers.portal.open",
        title: "Open model provider API key settings",
        group: "Settings: Providers",
        scope,
        availability: () =>
          active("providers") ? { state: "enabled" } : { state: "hidden" },
        execute: () => {
          const setup = state().props.providerSetup;
          void setup.onOpenProviderPortal(setup.provider);
        },
      },
      {
        id: "settings.workspace.mode.select",
        title: "Choose default workspace mode",
        group: "Settings: Workspace",
        scope,
        availability: () => {
          const setup = state().props.workspaceSetup;
          if (!active("workspace")) return { state: "hidden" };
          return !setup.workspaceRoot || setup.saving
            ? {
                state: "disabled",
                reason: "Select an available workspace first.",
              }
            : { state: "enabled" };
        },
        children: () => ({
          id: "settings.workspace.mode.select.page",
          title: "Choose default workspace mode",
          searchPlaceholder: "Search modes",
          numericSelection: true,
          groups: [
            {
              id: "modes",
              items: (["ask", "machdoch"] as const).map((mode, index) => ({
                id: mode,
                title: RUN_MODE_META[mode].label,
                current: state().props.workspaceSetup.defaultMode === mode,
                numericKey: numericKey(index),
                execute: () =>
                  void state().props.workspaceSetup.onDefaultModeChange(mode),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.workspace.reasoning.select",
        title: "Choose default workspace reasoning",
        group: "Settings: Workspace",
        scope,
        availability: () => {
          const setup = state().props.workspaceSetup;
          if (!active("workspace")) return { state: "hidden" };
          return !setup.workspaceRoot || setup.saving
            ? {
                state: "disabled",
                reason: "Select an available workspace first.",
              }
            : { state: "enabled" };
        },
        children: () => {
          const setup = state().props.workspaceSetup;
          const options = getReasoningModesForProvider(
            setup.reasoningProvider ?? null,
            setup.reasoningModel,
          );
          const current = normalizeReasoningModeForProvider(
            setup.defaultReasoning,
            setup.reasoningProvider ?? null,
            setup.reasoningModel,
          );
          return {
            id: "settings.workspace.reasoning.select.page",
            title: "Choose default workspace reasoning",
            searchPlaceholder: "Search reasoning modes",
            numericSelection: true,
            groups: [
              {
                id: "reasoning",
                items: options.map((reasoning, index) => ({
                  id: reasoning,
                  title: REASONING_LABELS[reasoning],
                  current: current === reasoning,
                  numericKey: numericKey(index),
                  execute: () =>
                    void state().props.workspaceSetup.onReasoningModeChange(
                      reasoning,
                    ),
                })),
              },
            ],
          };
        },
      },
      {
        id: "settings.web-search.active-provider.select",
        title: "Choose active web-search provider",
        group: "Settings: Web search",
        scope,
        availability: () =>
          active("web-search")
            ? state().props.webSearchSetup.loading ||
              state().props.webSearchSetup.saving
              ? { state: "disabled", reason: "Web-search settings are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "settings.web-search.active-provider.select.page",
          title: "Choose active web-search provider",
          searchPlaceholder: "Search providers",
          numericSelection: true,
          groups: [
            {
              id: "providers",
              items: (["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const).map(
                (provider, index) => {
                  const configured =
                    provider === "none" ||
                    state().props.webSearchSetup.providerAvailability.some(
                      (item) => item.provider === provider && item.configured,
                    );
                  return {
                    id: provider,
                    title: getWebSearchProviderLabel(provider),
                    current:
                      state().props.webSearchSetup.activeProvider === provider,
                    numericKey: numericKey(index),
                    availability: configured
                      ? { state: "enabled" }
                      : {
                          state: "disabled",
                          reason: "Add this provider's API key first.",
                        },
                    execute: () =>
                      void state().props.webSearchSetup.onActiveProviderChange(
                        provider,
                      ),
                  };
                },
              ),
            },
          ],
        }),
      },
      {
        id: "settings.web-search.key-provider.select",
        title: "Choose web-search API key",
        group: "Settings: Web search",
        scope,
        availability: () =>
          active("web-search")
            ? state().props.webSearchSetup.loading ||
              state().props.webSearchSetup.saving
              ? { state: "disabled", reason: "Web-search settings are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "settings.web-search.key-provider.select.page",
          title: "Choose web-search API key",
          searchPlaceholder: "Search providers",
          groups: [
            {
              id: "providers",
              items: USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
                id: provider,
                title: getWebSearchProviderLabel(provider),
                current: state().props.webSearchSetup.provider === provider,
                execute: () =>
                  state().props.webSearchSetup.onProviderChange(provider),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.web-search.save",
        title: "Save web-search API key",
        group: "Settings: Web search",
        scope,
        availability: () =>
          !active("web-search")
            ? { state: "hidden" }
            : state().props.webSearchSetup.loading ||
                state().props.webSearchSetup.saving
              ? { state: "disabled", reason: "Web-search settings are busy." }
              : { state: "enabled" },
        execute: () =>
          void state().props.webSearchSetup.onSave(
            state().props.webSearchSetup.keyValue,
          ),
      },
      {
        id: "settings.mcp.scope.select",
        title: "Choose MCP configuration scope",
        group: "Settings: MCP",
        scope,
        availability: () =>
          active("mcp")
            ? state().props.mcpSetup.loading || state().props.mcpSetup.saving
              ? { state: "disabled", reason: "MCP settings are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "settings.mcp.scope.select.page",
          title: "Choose MCP configuration scope",
          searchPlaceholder: "Search scopes",
          numericSelection: true,
          groups: [
            {
              id: "scopes",
              items: MCP_CONFIG_SCOPE_OPTIONS.map((option, index) => ({
                id: option.value,
                title: option.label,
                current: state().props.mcpSetup.scope === option.value,
                numericKey: numericKey(index),
                availability:
                  option.value === "workspace" &&
                  !state().props.mcpSetup.workspaceAvailable
                    ? {
                        state: "disabled",
                        reason: "No workspace is available.",
                      }
                    : { state: "enabled" },
                execute: () =>
                  state().props.mcpSetup.onScopeChange(option.value),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.mcp.preset.insert",
        title: "Insert MCP preset",
        group: "Settings: MCP",
        scope,
        availability: () =>
          active("mcp")
            ? state().props.mcpSetup.presets.length
              ? { state: "enabled" }
              : { state: "disabled", reason: "No MCP presets are available." }
            : { state: "hidden" },
        children: () => ({
          id: "settings.mcp.preset.insert.page",
          title: "Insert MCP preset",
          searchPlaceholder: "Search MCP presets",
          groups: [
            {
              id: "presets",
              items: state().props.mcpSetup.presets.map((preset) => ({
                id: preset.id,
                title: preset.title,
                keywords: [preset.description ?? ""],
                execute: () => state().props.mcpSetup.onPresetInsert(preset.id),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.mcp.save",
        title: "Save MCP configuration",
        group: "Settings: MCP",
        scope,
        availability: () =>
          !active("mcp")
            ? { state: "hidden" }
            : state().props.mcpSetup.loading || state().props.mcpSetup.saving
              ? { state: "disabled", reason: "MCP settings are busy." }
              : { state: "enabled" },
        execute: () => void state().props.mcpSetup.onSave(),
      },
      {
        id: "settings.mcp.discovery.run",
        title: "Discover MCP capabilities",
        group: "Settings: MCP",
        scope,
        availability: () =>
          !active("mcp")
            ? { state: "hidden" }
            : state().props.mcpSetup.discoveryBusy ||
                !state().props.mcpSetup.discoveryServerId.trim()
              ? {
                  state: "disabled",
                  reason: "Choose an available MCP server first.",
                }
              : { state: "enabled" },
        execute: () =>
          void state().props.mcpSetup.onDiscoverServer(
            state().props.mcpSetup.discoveryServerId,
          ),
      },
      {
        id: "settings.mcp.discovery-cache.refresh",
        title: "Refresh MCP discovery cache",
        group: "Settings: MCP",
        scope,
        availability: () =>
          !active("mcp")
            ? { state: "hidden" }
            : state().props.mcpSetup.discoveryBusy
              ? { state: "disabled", reason: "MCP discovery is busy." }
              : { state: "enabled" },
        execute: () =>
          void state().props.mcpSetup.onRefreshDiscoveryCache(
            state().props.mcpSetup.discoveryServerId || undefined,
          ),
      },
      {
        id: "settings.mcp.discovery-cache.list",
        title: "List MCP discovery cache",
        group: "Settings: MCP",
        scope,
        availability: () =>
          !active("mcp")
            ? { state: "hidden" }
            : state().props.mcpSetup.discoveryBusy
              ? { state: "disabled", reason: "MCP discovery is busy." }
              : { state: "enabled" },
        execute: () => void state().props.mcpSetup.onListDiscoveryCache(),
      },
      {
        id: "settings.mcp.oauth.start",
        title: "Start MCP OAuth",
        group: "Settings: MCP",
        scope,
        availability: () =>
          !active("mcp")
            ? { state: "hidden" }
            : state().props.mcpSetup.oauthBusy ||
                !state().props.mcpSetup.oauthServerId.trim()
              ? {
                  state: "disabled",
                  reason: "Choose an OAuth MCP server first.",
                }
              : { state: "enabled" },
        execute: () =>
          void state().props.mcpSetup.onStartOAuth(
            state().props.mcpSetup.oauthServerId,
          ),
      },
      {
        id: "settings.mcp.oauth.finish",
        title: "Finish MCP OAuth",
        group: "Settings: MCP",
        scope,
        availability: () =>
          !active("mcp")
            ? { state: "hidden" }
            : state().props.mcpSetup.oauthBusy ||
                !state().props.mcpSetup.oauthServerId.trim() ||
                !state().props.mcpSetup.oauthCallback.trim()
              ? { state: "disabled", reason: "Enter the OAuth callback first." }
              : { state: "enabled" },
        execute: () =>
          void state().props.mcpSetup.onFinishOAuth(
            state().props.mcpSetup.oauthServerId,
            state().props.mcpSetup.oauthCallback,
          ),
      },
      {
        id: "settings.memory.toggle",
        title: "Toggle global memory",
        group: "Settings: Memory",
        scope,
        availability: () =>
          !active("memory")
            ? { state: "hidden" }
            : state().props.memorySetup.saving
              ? { state: "disabled", reason: "Memory settings are saving." }
              : { state: "enabled" },
        current: () => state().props.memorySetup.settings.globalEnabled,
        execute: () =>
          void state().props.memorySetup.onGlobalEnabledChange(
            !state().props.memorySetup.settings.globalEnabled,
          ),
      },
      {
        id: "settings.appearance.theme.select",
        title: "Choose interface theme",
        group: "Settings: Appearance",
        scope,
        availability: () =>
          !active("appearance")
            ? { state: "hidden" }
            : state().props.appearanceSetup.saving
              ? { state: "disabled", reason: "Appearance is saving." }
              : { state: "enabled" },
        children: () => ({
          id: "settings.appearance.theme.select.page",
          title: "Choose interface theme",
          searchPlaceholder: "Search themes",
          numericSelection: true,
          groups: [
            {
              id: "themes",
              items: (["dark", "light"] as const).map((theme, index) => ({
                id: theme,
                title: theme === "dark" ? "Dark" : "Light",
                current: state().props.appearanceSetup.settings.theme === theme,
                numericKey: numericKey(index),
                execute: () =>
                  void state().props.appearanceSetup.onSave({
                    ...state().props.appearanceSetup.settings,
                    theme,
                    version: 1,
                  }),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.appearance.density.select",
        title: "Choose interface density",
        group: "Settings: Appearance",
        scope,
        availability: () =>
          !active("appearance")
            ? { state: "hidden" }
            : state().props.appearanceSetup.saving
              ? { state: "disabled", reason: "Appearance is saving." }
              : { state: "enabled" },
        children: () => ({
          id: "settings.appearance.density.select.page",
          title: "Choose interface density",
          searchPlaceholder: "Search densities",
          numericSelection: true,
          groups: [
            {
              id: "densities",
              items: (["comfortable", "compact"] as const).map(
                (density, index) => ({
                  id: density,
                  title: density === "comfortable" ? "Comfortable" : "Compact",
                  current:
                    state().props.appearanceSetup.settings.density === density,
                  numericKey: numericKey(index),
                  execute: () =>
                    void state().props.appearanceSetup.onSave({
                      ...state().props.appearanceSetup.settings,
                      density,
                      version: 1,
                    }),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "settings.appearance.accent.select",
        title: "Choose interface accent",
        group: "Settings: Appearance",
        scope,
        availability: () =>
          !active("appearance")
            ? { state: "hidden" }
            : state().props.appearanceSetup.saving
              ? { state: "disabled", reason: "Appearance is saving." }
              : { state: "enabled" },
        children: () => ({
          id: "settings.appearance.accent.select.page",
          title: "Choose interface accent",
          searchPlaceholder: "Search accents",
          numericSelection: true,
          groups: [
            {
              id: "accents",
              items: (
                [
                  ["sky", "Sky"],
                  ["emerald", "Sage"],
                  ["violet", "Violet"],
                  ["amber", "Amber"],
                ] as const
              ).map(([accent, title], index) => ({
                id: accent,
                title,
                current:
                  state().props.appearanceSetup.settings.accent === accent,
                numericKey: numericKey(index),
                execute: () =>
                  void state().props.appearanceSetup.onSave({
                    ...state().props.appearanceSetup.settings,
                    accent,
                    version: 1,
                  }),
              })),
            },
          ],
        }),
      },
      {
        id: "settings.appearance.quick-chat-style.select",
        title: "Choose Quick Chat bubble style",
        group: "Settings: Appearance",
        scope,
        availability: () =>
          !active("appearance")
            ? { state: "hidden" }
            : state().props.appearanceSetup.saving
              ? { state: "disabled", reason: "Appearance is saving." }
              : { state: "enabled" },
        children: () => ({
          id: "settings.appearance.quick-chat-style.select.page",
          title: "Choose Quick Chat bubble style",
          searchPlaceholder: "Search styles",
          numericSelection: true,
          groups: [
            {
              id: "styles",
              items: (["classic", "glass", "pulse", "orbit"] as const).map(
                (quickChatBubbleStyle, index) => ({
                  id: quickChatBubbleStyle,
                  title: `${quickChatBubbleStyle[0]?.toUpperCase()}${quickChatBubbleStyle.slice(1)}`,
                  current:
                    state().props.appearanceSetup.settings
                      .quickChatBubbleStyle === quickChatBubbleStyle,
                  numericKey: numericKey(index),
                  execute: () =>
                    void state().props.appearanceSetup.onSave({
                      ...state().props.appearanceSetup.settings,
                      quickChatBubbleStyle,
                      version: 1,
                    }),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "settings.voice.speech-input.select",
        title: "Choose speech-input provider",
        group: "Settings: Voice",
        scope,
        availability: () =>
          active("voice")
            ? state().props.voiceSetup.speechToTextProviderSaving
              ? { state: "disabled", reason: "Speech settings are saving." }
              : { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "settings.voice.speech-input.select.page",
          title: "Choose speech-input provider",
          searchPlaceholder: "Search providers",
          numericSelection: true,
          groups: [
            {
              id: "providers",
              items: (
                ["none", ...USER_SPEECH_TO_TEXT_PROVIDER_ORDER] as const
              ).map((provider, index) => {
                const configured =
                  provider === "none" ||
                  state().props.voiceSetup.speechToTextProviderAvailability.some(
                    (item) => item.provider === provider && item.configured,
                  );
                return {
                  id: provider,
                  title:
                    provider === "none"
                      ? "Disabled"
                      : getProviderLabel(provider),
                  current:
                    state().props.voiceSetup.speechToTextProvider === provider,
                  numericKey: numericKey(index),
                  availability: configured
                    ? { state: "enabled" }
                    : {
                        state: "disabled",
                        reason: "Add this provider's API key first.",
                      },
                  execute: () =>
                    void state().props.voiceSetup.onSpeechToTextProviderChange(
                      provider,
                    ),
                };
              }),
            },
          ],
        }),
      },
      {
        id: "settings.voice.input-device.select",
        title: "Choose speech input device",
        group: "Settings: Voice",
        scope,
        availability: () =>
          !active("voice")
            ? { state: "hidden" }
            : !state().props.voiceSetup.speechInputDevicesSupported ||
                state().props.voiceSetup.speechInputDeviceSaving
              ? {
                  state: "disabled",
                  reason: "Microphone selection is unavailable.",
                }
              : { state: "enabled" },
        children: () => ({
          id: "settings.voice.input-device.select.page",
          title: "Choose speech input device",
          searchPlaceholder: "Search microphones",
          groups: [
            {
              id: "devices",
              items: [
                {
                  id: "default",
                  title: "System default",
                  current:
                    state().props.voiceSetup.speechInputDeviceId === null,
                  execute: () =>
                    void state().props.voiceSetup.onSpeechInputDeviceChange(
                      null,
                    ),
                },
                ...state().props.voiceSetup.speechInputDevices.map(
                  (device) => ({
                    id: device.deviceId,
                    title: device.label,
                    current:
                      state().props.voiceSetup.speechInputDeviceId ===
                      device.deviceId,
                    execute: () =>
                      void state().props.voiceSetup.onSpeechInputDeviceChange(
                        device.deviceId,
                      ),
                  }),
                ),
              ],
            },
          ],
        }),
      },
      {
        id: "settings.voice.input-devices.refresh",
        title: "Refresh speech input devices",
        group: "Settings: Voice",
        scope,
        availability: () =>
          !active("voice")
            ? { state: "hidden" }
            : !state().props.voiceSetup.speechInputDevicesSupported ||
                state().props.voiceSetup.speechInputDevicesRefreshing
              ? {
                  state: "disabled",
                  reason: "Microphone discovery is unavailable.",
                }
              : { state: "enabled" },
        execute: () =>
          void state().props.voiceSetup.onRefreshSpeechInputDevices(),
      },
      {
        id: "settings.voice.provider.select",
        title: "Choose voice provider",
        group: "Settings: Voice",
        scope,
        availability: () =>
          active("voice")
            ? state().props.voiceSetup.aiProviderSaving
              ? { state: "disabled", reason: "Voice settings are saving." }
              : { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "settings.voice.provider.select.page",
          title: "Choose voice provider",
          searchPlaceholder: "Search providers",
          numericSelection: true,
          groups: [
            {
              id: "providers",
              items: (["none", ...USER_VOICE_AI_PROVIDER_ORDER] as const).map(
                (provider, index) => {
                  const configured =
                    provider === "none" ||
                    state().props.voiceSetup.aiProviderAvailability.some(
                      (item) => item.provider === provider && item.configured,
                    );
                  return {
                    id: provider,
                    title:
                      provider === "none"
                        ? "System voices only"
                        : getProviderLabel(provider),
                    current: state().props.voiceSetup.aiProvider === provider,
                    numericKey: numericKey(index),
                    availability: configured
                      ? { state: "enabled" }
                      : {
                          state: "disabled",
                          reason: "Add this provider's API key first.",
                        },
                    execute: () =>
                      void state().props.voiceSetup.onAiProviderChange(
                        provider,
                      ),
                  };
                },
              ),
            },
          ],
        }),
      },
      {
        id: "settings.voice.auto-speak.toggle",
        title: "Toggle automatic spoken replies",
        group: "Settings: Voice",
        scope,
        availability: () =>
          !active("voice")
            ? { state: "hidden" }
            : state().props.voiceSetup.supported
              ? { state: "enabled" }
              : { state: "disabled", reason: "Speech output is unavailable." },
        current: () => state().props.voiceSetup.autoSpeakResponses,
        execute: () =>
          state().props.voiceSetup.onAutoSpeakResponsesChange(
            !state().props.voiceSetup.autoSpeakResponses,
          ),
      },
      {
        id: "settings.voice.system-voice.select",
        title: "Choose system voice",
        group: "Settings: Voice",
        scope,
        availability: () =>
          !active("voice")
            ? { state: "hidden" }
            : state().props.voiceSetup.systemVoicesSupported
              ? { state: "enabled" }
              : { state: "disabled", reason: "System voices are unavailable." },
        children: () => ({
          id: "settings.voice.system-voice.select.page",
          title: "Choose system voice",
          searchPlaceholder: "Search voices",
          groups: [
            {
              id: "voices",
              items: [
                {
                  id: "default",
                  title: "System default",
                  current: state().props.voiceSetup.preferredVoiceURI === null,
                  execute: () =>
                    state().props.voiceSetup.onPreferredVoiceChange(null),
                },
                ...state().props.voiceSetup.voiceOptions.map((voice) => ({
                  id: voice.voiceURI,
                  title: voice.label,
                  current:
                    state().props.voiceSetup.preferredVoiceURI ===
                    voice.voiceURI,
                  execute: () =>
                    state().props.voiceSetup.onPreferredVoiceChange(
                      voice.voiceURI,
                    ),
                })),
              ],
            },
          ],
        }),
      },
      {
        id: "settings.voice.rate.select",
        title: "Choose speech rate",
        group: "Settings: Voice",
        scope,
        availability: () =>
          !active("voice")
            ? { state: "hidden" }
            : state().props.voiceSetup.systemVoicesSupported
              ? { state: "enabled" }
              : { state: "disabled", reason: "System voices are unavailable." },
        children: () => ({
          id: "settings.voice.rate.select.page",
          title: "Choose speech rate",
          searchPlaceholder: "Search rates",
          numericSelection: true,
          groups: [
            {
              id: "rates",
              items: [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4].map((rate, index) => ({
                id: `${rate}`,
                title: `${rate.toFixed(2)}x`,
                current: state().props.voiceSetup.rate === rate,
                numericKey: numericKey(index),
                execute: () => state().props.voiceSetup.onRateChange(rate),
              })),
            },
          ],
        }),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(settingsCommands);

  return (
    <DialogContent
      data-command-owner="settings-dialog"
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
      <SubmitShortcut asChild>
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
              tooltip={closeLabel}
              disabled={closeActionRunning || primaryActionRunning}
              onClick={requestClose}
              className="h-9 w-9 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <SubmitShortcut asChild>
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
                  {dialogSections
                    .filter((section) => section.group === group)
                    .map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
        </SubmitShortcut>

        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[13rem_minmax(0,1fr)]">
          <SubmitShortcut asChild>
            <nav
              aria-label="Settings sections"
              className="hidden min-h-0 overflow-y-auto border-r border-slate-800/80 bg-slate-950/70 px-3 py-3 md:block"
            >
            <SearchField
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Find settings"
              placeholder="Find settings"
              containerClassName="mb-3"
              className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
            />

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
          </SubmitShortcut>

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
                {...SUBMIT_SHORTCUT_ACTION_PROPS}
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
      </SubmitShortcut>

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
