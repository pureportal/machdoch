import {
  ArrowLeftRight,
  Brain,
  Gauge,
  KeyRound,
  Monitor,
  Network,
  Palette,
  Search,
  Timer,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useId,
  useRef,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Button } from "../../components/ui/button";
import { SearchField } from "../../components/ui/search-field";
import { SubmitShortcut } from "../../components/ui/submit-shortcut";
import { cn } from "../../lib/utils";
import type {
  SettingsSection,
  SettingsSectionGroup,
} from "../_helpers/session-shell";

export const INTRO_SECTION_ID = "__intro";
export type SettingsDialogSectionId = SettingsSection | typeof INTRO_SECTION_ID;
export interface SettingsDialogSectionDefinition {
  id: SettingsDialogSectionId;
  label: string;
  group: SettingsSectionGroup;
  description: string;
  keywords: readonly string[];
}

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  providers: KeyRound,
  "web-search": Search,
  mcp: Network,
  agent: Gauge,
  appearance: Palette,
  voice: Volume2,
  memory: Brain,
  desktop: Monitor,
  "workspace-run": Timer,
  transfer: ArrowLeftRight,
};
export const SETTINGS_SECTION_GROUP_ORDER: readonly SettingsSectionGroup[] = [
  "Setup",
  "Agent",
  "Capabilities",
  "App",
  "Data",
];

export const SettingsNavigation = ({
  sections,
  visibleSections,
  activeSectionId,
  introIcon = KeyRound,
  query,
  onQueryChange,
  onSectionChange,
  onNavigationKeyDown,
  buttonRefs,
  mobileSectionRef,
}: {
  sections: readonly SettingsDialogSectionDefinition[];
  visibleSections: readonly SettingsDialogSectionDefinition[];
  activeSectionId: SettingsDialogSectionId;
  introIcon?: LucideIcon;
  query: string;
  onQueryChange: (query: string) => void;
  onSectionChange: (section: SettingsDialogSectionId) => void;
  onNavigationKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    section: SettingsDialogSectionId,
  ) => void;
  buttonRefs: RefObject<Map<SettingsDialogSectionId, HTMLButtonElement>>;
  mobileSectionRef: RefObject<HTMLSelectElement | null>;
}): JSX.Element => {
  const selectId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;
  const clearSearch = (): void => {
    onQueryChange("");
    searchRef.current?.focus();
  };

  return (
    <SubmitShortcut asChild>
      <nav
        aria-label="Settings sections"
        className="flex min-h-0 flex-col border-b border-slate-800/80 bg-slate-950/70 md:border-r md:border-b-0"
      >
        <div className="shrink-0 p-3">
          <SearchField
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label="Find settings"
            placeholder="Find settings"
            onKeyDown={(event) => {
              if (event.key === "Enter" && searching && visibleSections[0]) {
                event.preventDefault();
                onSectionChange(visibleSections[0].id);
              } else if (event.key === "ArrowDown" && visibleSections[0]) {
                event.preventDefault();
                buttonRefs.current.get(visibleSections[0].id)?.focus();
              }
            }}
            endAdornment={
              query ? (
                <button
                  type="button"
                  aria-label="Clear settings search"
                  onClick={clearSearch}
                  className="flex size-6 items-center justify-center rounded text-slate-400 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-sky-400"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              ) : undefined
            }
            className="h-10 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100 placeholder:text-[var(--app-muted)] [&::-webkit-search-cancel-button]:hidden"
          />
          {!searching ? (
            <div className="mt-2 md:hidden">
              <label htmlFor={selectId} className="sr-only">
                Settings section
              </label>
              <select
                ref={mobileSectionRef}
                id={selectId}
                value={activeSectionId}
                onChange={(event) =>
                  onSectionChange(event.target.value as SettingsDialogSectionId)
                }
                className="h-10 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                {SETTINGS_SECTION_GROUP_ORDER.map((group) => (
                  <optgroup key={group} label={group}>
                    {sections
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
          ) : null}
        </div>
        <div
          className={cn(
            "min-h-0 overflow-y-auto px-3 pb-3",
            searching ? "max-h-[30dvh] md:max-h-none" : "hidden md:block",
          )}
        >
          {visibleSections.length === 0 ? (
            <p role="status" className="px-2 py-3 text-sm text-slate-400">
              No settings found.
            </p>
          ) : (
            <div className="grid gap-4">
              {SETTINGS_SECTION_GROUP_ORDER.map((group) => {
                const groupSections = visibleSections.filter(
                  (section) => section.group === group,
                );
                if (groupSections.length === 0) return null;
                return (
                  <div key={group} className="grid gap-1">
                    <p className="px-3 pb-1 text-xs font-medium text-slate-400">
                      {group}
                    </p>
                    {groupSections.map((section) => {
                      const Icon =
                        section.id === INTRO_SECTION_ID
                          ? introIcon
                          : SECTION_ICONS[section.id];
                      const selected = section.id === activeSectionId;
                      return (
                        <Button
                          key={section.id}
                          ref={(node) => {
                            if (node) buttonRefs.current.set(section.id, node);
                            else buttonRefs.current.delete(section.id);
                          }}
                          type="button"
                          variant="ghost"
                          aria-current={selected ? "page" : undefined}
                          onClick={() => onSectionChange(section.id)}
                          onKeyDown={(event) =>
                            onNavigationKeyDown(event, section.id)
                          }
                          className={cn(
                            "h-9 w-full justify-start rounded-lg border border-transparent px-3 text-sm text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                            selected &&
                              "border-sky-500/25 bg-sky-500/10 font-semibold text-sky-100",
                          )}
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                          <span className="truncate">{section.label}</span>
                        </Button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </nav>
    </SubmitShortcut>
  );
};
