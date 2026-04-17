import { Check, CircleDashed, FolderOpen } from "lucide-react";
import type { JSX } from "react";
import type { ChatSessionRecord } from "../../chat-session.model";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { getProviderLabel } from "../../model-catalog";
import type { RuntimeSnapshot } from "../../runtime";
import {
  getWebSearchProviderLabel,
  getWorkspaceLabel,
} from "../_helpers/session-shell";

export interface SessionRuntimePopoverProps {
  activeSession: ChatSessionRecord;
  activeRunModeLabel: string;
  activeRunModeBadgeClassName: string;
  isUsingWorkspaceDefaultMode: boolean;
  runtimeSnapshot: RuntimeSnapshot | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  onSelectFolder: () => Promise<void>;
  onSessionProfileSelection: (profile: string | null) => Promise<void>;
}

export const SessionRuntimePopover = ({
  activeSession,
  activeRunModeLabel,
  activeRunModeBadgeClassName,
  isUsingWorkspaceDefaultMode,
  runtimeSnapshot,
  runtimeLoading,
  runtimeError,
  onSelectFolder,
  onSessionProfileSelection,
}: SessionRuntimePopoverProps): JSX.Element => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-2xl border-slate-800 bg-slate-950 hover:bg-slate-900 hover:text-slate-100"
        >
          <FolderOpen className="mr-2 h-4 w-4" />
          Routing & Workspace
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="grid gap-5">
          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                Workspace
              </p>
              {activeSession.workspace ? (
                <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-200">
                  Ready
                </Badge>
              ) : null}
            </div>

            <div
              className={cn(
                "rounded-2xl border border-dashed p-3 transition-all",
                activeSession.workspace
                  ? "border-sky-500/25 bg-sky-500/10"
                  : "border-slate-800 bg-slate-950/60",
              )}
            >
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-900 text-slate-300">
                  <FolderOpen className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-100">
                    {getWorkspaceLabel(activeSession.workspace)}
                  </p>
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void onSelectFolder();
              }}
              className="h-9 rounded-xl border-slate-800 bg-slate-900 hover:bg-slate-800 hover:text-slate-100"
            >
              {activeSession.workspace ? "Change folder" : "Select directory"}
            </Button>
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                Session runtime
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                Provider: {getProviderLabel(activeSession.provider)}
              </Badge>
              <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                Model: {activeSession.model}
              </Badge>
              <Badge className={cn("border", activeRunModeBadgeClassName)}>
                Mode: {activeRunModeLabel}
              </Badge>
              {activeSession.profile ? (
                <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                  Profile: {activeSession.profile}
                </Badge>
              ) : null}
              {isUsingWorkspaceDefaultMode ? (
                <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                  Uses workspace default
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                Profile routing
              </p>
              <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                {activeSession.profile ? "Session override" : "Workspace default"}
              </Badge>
            </div>

            {runtimeSnapshot ? (
              runtimeSnapshot.availableProfiles.length > 0 ? (
                <div className="grid gap-2">
                  <button
                    type="button"
                    aria-label="Use workspace default profile"
                    onClick={() => {
                      void onSessionProfileSelection(null);
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                      !activeSession.profile
                        ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                        : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-slate-300">
                      <CircleDashed className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-100">
                          Workspace default
                        </p>
                        {!activeSession.profile ? (
                          <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-200">
                            Current
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-400">
                        {runtimeSnapshot.activeProfile
                          ? `Currently ${runtimeSnapshot.activeProfile}. Use your workspace default profile, config, or environment routing.`
                          : "Use your workspace config and environment defaults when no named profile override is needed."}
                      </p>
                    </div>
                  </button>

                  {runtimeSnapshot.availableProfiles.map((profile) => {
                    const isSelected = activeSession.profile === profile.name;

                    return (
                      <button
                        key={profile.name}
                        type="button"
                        aria-label={`Use profile ${profile.name}`}
                        onClick={() => {
                          void onSessionProfileSelection(profile.name);
                        }}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                          isSelected
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                            : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                        )}
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-slate-300">
                          <Check className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-slate-100">
                              {profile.name}
                            </p>
                            {isSelected ? (
                              <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-200">
                                Current
                              </Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs leading-5 text-slate-400">
                            {profile.description ??
                              `Use the \`${profile.name}\` profile for this session.`}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm leading-6 text-slate-500">
                  No named profiles are configured for this workspace yet.
                </p>
              )
            ) : (
              <p className="text-sm leading-6 text-slate-500">
                Select a workspace to load its named profiles.
              </p>
            )}
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                Runtime Snapshot
              </p>
              {runtimeLoading ? (
                <span className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                  Refreshing…
                </span>
              ) : null}
            </div>

            {runtimeSnapshot ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
                <div className="flex flex-wrap gap-2">
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    Mode: {runtimeSnapshot.mode}
                  </Badge>
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    Tools: {runtimeSnapshot.enabledTools.join(", ")}
                  </Badge>
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    {runtimeSnapshot.provider}
                  </Badge>
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    {runtimeSnapshot.model}
                  </Badge>
                  <Badge
                    className={cn(
                      "border text-slate-100",
                      runtimeSnapshot.webSearch.activeProvider !== "none" &&
                        runtimeSnapshot.webSearch.providerAvailability.some(
                          (entry) =>
                            entry.provider ===
                              runtimeSnapshot.webSearch.activeProvider &&
                            entry.configured,
                        )
                        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                        : "border-slate-700 bg-slate-950 text-slate-300",
                    )}
                  >
                    Web search:{" "}
                    {runtimeSnapshot.webSearch.activeProvider !== "none" &&
                    runtimeSnapshot.webSearch.providerAvailability.some(
                      (entry) =>
                        entry.provider ===
                          runtimeSnapshot.webSearch.activeProvider &&
                        entry.configured,
                    )
                      ? getWebSearchProviderLabel(
                          runtimeSnapshot.webSearch.activeProvider,
                        )
                      : "Hidden"}
                  </Badge>
                  {runtimeSnapshot.activeProfile ? (
                    <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                      Profile: {runtimeSnapshot.activeProfile}
                    </Badge>
                  ) : null}
                  {runtimeSnapshot.offline ? (
                    <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-200">
                      Offline
                    </Badge>
                  ) : null}
                  {runtimeSnapshot.compatibility
                    .discoverGithubCustomizations ? (
                    <Badge className="border-violet-500/20 bg-violet-500/10 text-violet-200">
                      GitHub compatibility
                    </Badge>
                  ) : null}
                </div>
              </div>
            ) : runtimeError ? (
              <p className="text-sm leading-6 text-amber-200">{runtimeError}</p>
            ) : (
              <p className="text-sm leading-6 text-slate-500">
                Runtime metadata falls back to your home folder until you choose
                a workspace.
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
