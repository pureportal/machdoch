import {
  Brain,
  FileText,
  Folder,
  Gauge,
  KeyRound,
  Monitor,
  Network,
  Palette,
  Search,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { cn } from "../../lib/utils";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../_helpers/session-shell";
import { AgentLimitsSettingsPanel } from "./settings-dialog-panels/agent-limits-settings-panel";
import { AppearanceSettingsPanel } from "./settings-dialog-panels/appearance-settings-panel";
import { DesktopSettingsPanel } from "./settings-dialog-panels/desktop-settings-panel";
import { InstructionSettingsPanel } from "./settings-dialog-panels/instruction-settings-panel";
import { MemorySettingsPanel } from "./settings-dialog-panels/memory-settings-panel";
import { McpSettingsPanel } from "./settings-dialog-panels/mcp-settings-panel";
import { ProviderSettingsPanel } from "./settings-dialog-panels/provider-settings-panel";
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
  "web-search": Search,
  mcp: Network,
  agent: Gauge,
  appearance: Palette,
  voice: Volume2,
  memory: Brain,
  desktop: Monitor,
};

export interface SettingsDialogProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
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
  }
};

export const SettingsDialog = (props: SettingsDialogProps): JSX.Element => {
  const { settingsSection, onSettingsSectionChange } = props;

  return (
    <DialogContent className="app-settings-dialog max-h-[min(720px,calc(100vh-28px))] w-[min(980px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
      <div className="flex max-h-[min(720px,calc(100vh-28px))] min-h-[420px] flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle className="text-xl font-semibold text-white">
            Settings
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure providers, workspace defaults, web search, appearance,
            instruction files, MCP servers, voice, memory, and desktop behavior.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav className="border-b border-slate-800/80 bg-slate-950/80 px-3 py-3 md:border-r md:border-b-0">
            <div className="flex gap-1 overflow-x-auto md:grid md:overflow-visible">
              {SETTINGS_SECTIONS.map((section) => {
                const SectionIcon = SETTINGS_SECTION_ICONS[section.id];

                return (
                  <Button
                    key={section.id}
                    type="button"
                    variant="ghost"
                    onClick={() => onSettingsSectionChange(section.id)}
                    className={cn(
                      "h-9 shrink-0 justify-start rounded-lg border border-transparent bg-transparent px-3 text-sm text-slate-400 hover:border-slate-800 hover:bg-slate-900/70 hover:text-slate-100 md:w-full",
                      settingsSection === section.id &&
                        "border-sky-500/25 bg-sky-500/10 text-sky-100",
                    )}
                  >
                    <SectionIcon className="h-4 w-4" />
                    <span>{section.label}</span>
                  </Button>
                );
              })}
            </div>
          </nav>

          <ScrollArea
            className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:w-3 [&_[data-slot=scroll-area-scrollbar]]:border-l [&_[data-slot=scroll-area-scrollbar]]:border-l-slate-800 [&_[data-slot=scroll-area-scrollbar]]:bg-slate-950/80 [&_[data-slot=scroll-area-thumb]]:bg-slate-600/80 [&_[data-slot=scroll-area-thumb]]:hover:bg-slate-500"
            type="always"
          >
            <div className="grid content-start gap-5 px-6 py-5 pr-10">
              {renderSettingsPanel(props)}
            </div>
          </ScrollArea>
        </div>
      </div>
    </DialogContent>
  );
};
