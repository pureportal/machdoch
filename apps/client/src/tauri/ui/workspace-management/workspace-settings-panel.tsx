import { Check, FolderGit2, LoaderCircle, Save, X } from "lucide-react";
import { useId, type JSX } from "react";
import { MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH } from "@machdoch/fleet-protocol/instruction-limits";
import {
  TagEditor,
  type InstructionManagementControls,
} from "@machdoch/client-ui/instructions";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  InstructionProfileView,
  InstructionWorkspaceView,
} from "../runtime";
import type { WorkspaceManagementControls } from "./types";
import { WorkspaceConfigurationSettings } from "./workspace-configuration-settings";
import {
  getManagedWorkspaceName,
  profileIsAutomaticForWorkspace,
  type ManagedWorkspaceView,
} from "./workspace-management-model";
import { WorkspaceMcpSettings } from "./workspace-mcp-settings";

export interface WorkspaceIdentityDraft {
  displayName: string;
  tags: string[];
  tagDraftPending: boolean;
  displayNameError: string | null;
  dirty: boolean;
  onDisplayNameChange: (value: string) => void;
  onTagsChange: (tags: string[]) => void;
  onTagDraftPendingChange: (pending: boolean) => void;
  onSave: () => void;
}

const IdentityForm = ({
  draft,
  disabled,
}: {
  draft: WorkspaceIdentityDraft;
  disabled: boolean;
}): JSX.Element => {
  const displayNameErrorId = useId();
  const pendingTagMessageId = useId();
  const showNameError = draft.displayNameError !== null && draft.dirty;
  return (
    <SubmitShortcut asChild>
      <section
        aria-label="Workspace identity"
        className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4 md:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1.35fr)_auto] md:items-end"
      >
        <label className="grid gap-1.5 text-xs font-medium text-slate-400">
          Name
          <Input
            value={draft.displayName}
            maxLength={MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH * 2}
            disabled={disabled}
            aria-invalid={draft.displayNameError !== null}
            aria-describedby={showNameError ? displayNameErrorId : undefined}
            onChange={(event) => draft.onDisplayNameChange(event.target.value)}
            className="h-9 border-slate-800 bg-slate-950"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-slate-400">
          Tags
          <TagEditor
            value={draft.tags}
            disabled={disabled}
            onChange={draft.onTagsChange}
            onPendingChange={draft.onTagDraftPendingChange}
          />
        </label>
        <Button
          type="button"
          size="sm"
          disabled={
            disabled ||
            !draft.dirty ||
            draft.tagDraftPending ||
            draft.displayNameError !== null
          }
          aria-describedby={
            draft.tagDraftPending ? pendingTagMessageId : undefined
          }
          onClick={draft.onSave}
          {...SUBMIT_SHORTCUT_ACTION_PROPS}
        >
          <Save className="size-4" />
          Save
        </Button>
        {showNameError ? (
          <p
            id={displayNameErrorId}
            role="alert"
            className="text-xs text-red-300 md:col-span-3"
          >
            {draft.displayNameError}
          </p>
        ) : null}
        {draft.tagDraftPending ? (
          <p
            id={pendingTagMessageId}
            className="text-xs text-slate-500 md:col-span-3"
          >
            Add or clear the pending tag before saving.
          </p>
        ) : null}
      </section>
    </SubmitShortcut>
  );
};

const profileState = (
  profile: InstructionProfileView,
  automatic: boolean,
  rootAssigned: boolean,
  scopedCount: number,
): string => {
  if (!profile.enabled) {
    return `${profile.match !== undefined ? "Tag match" : "Manual"} · Disabled`;
  }
  if (profile.global) return "Always applied";
  if (profile.match !== undefined)
    return automatic ? "Tag match" : "No tag match";
  if (rootAssigned) return "Manual";
  return scopedCount > 0 ? `${scopedCount} scoped` : "Available";
};

const InstructionAssignments = ({
  setup,
  profiles,
  workspace,
  libraryError,
  libraryAvailable,
  settingsDirty,
  onAssign,
  onRemoveScoped,
}: {
  setup: InstructionManagementControls;
  profiles: readonly InstructionProfileView[];
  workspace: InstructionWorkspaceView | null;
  libraryError: string | null;
  libraryAvailable: boolean;
  settingsDirty: boolean;
  onAssign: (profileId: string, assigned: boolean) => void;
  onRemoveScoped: (
    profileId: string,
    path: string,
    profileIds: readonly string[],
  ) => void;
}): JSX.Element => {
  const rootProfiles =
    workspace?.scopes.find((scope) => scope.path === ".")?.profiles ?? [];
  const effectiveCount = profiles.filter(
    (profile) =>
      profile.enabled &&
      (profile.global ||
        rootProfiles.includes(profile.id) ||
        profileIsAutomaticForWorkspace(profile, workspace)),
  ).length;
  const disabled = setup.saving || settingsDirty || !libraryAvailable;
  return (
    <section
      aria-label="Instructions"
      className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/20 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-200">Instructions</h3>
        <span className="text-xs text-slate-500">
          {effectiveCount} effective
        </span>
      </div>
      {libraryError ? (
        <p role="alert" className="text-sm text-red-300">
          {libraryError}
        </p>
      ) : !setup.registry ? (
        setup.loading ? (
          <div className="grid h-24 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-slate-500" />
          </div>
        ) : (
          <EmptyState
            icon={FolderGit2}
            title="Instruction library unavailable"
            size="compact"
          />
        )
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No instruction files"
          size="compact"
        />
      ) : (
        <div className="space-y-2">
          {settingsDirty ? (
            <p className="text-xs text-slate-500">
              Save workspace settings before changing assignments.
            </p>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {profiles.map((profile) => {
              const rootAssigned = rootProfiles.includes(profile.id);
              const scopedAssignments =
                workspace?.scopes.filter(
                  (scope) =>
                    scope.path !== "." && scope.profiles.includes(profile.id),
                ) ?? [];
              const automatic = profileIsAutomaticForWorkspace(
                profile,
                workspace,
              );
              const active =
                profile.enabled &&
                (profile.global || automatic || rootAssigned);
              const readOnly = profile.global || profile.match !== undefined;
              return (
                <div
                  key={profile.id}
                  className={cn(
                    "min-w-0 rounded-lg border bg-slate-950/45 px-3 py-2.5",
                    active ? "border-sky-900/80" : "border-slate-800",
                    !profile.enabled && "opacity-55",
                  )}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {readOnly ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 grid size-4 place-items-center rounded-sm border",
                          active
                            ? "border-sky-500/70 text-sky-300"
                            : "border-slate-700 text-transparent",
                        )}
                      >
                        <Check className="size-3" />
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Assign ${profile.name} manually`}
                        checked={rootAssigned}
                        disabled={
                          disabled || (!profile.enabled && !rootAssigned)
                        }
                        onChange={(event) =>
                          onAssign(profile.id, event.target.checked)
                        }
                        className="mt-0.5 accent-sky-500"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-200">
                        {profile.name}
                      </p>
                      {profile.description ? (
                        <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                          {profile.description}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-[11px]",
                        active ? "text-sky-300" : "text-slate-600",
                      )}
                    >
                      {profileState(
                        profile,
                        automatic,
                        rootAssigned,
                        scopedAssignments.length,
                      )}
                    </span>
                  </div>
                  {scopedAssignments.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2">
                      {scopedAssignments.map((scope) => (
                        <li
                          key={scope.path}
                          className="flex min-w-0 items-center gap-1.5 pl-6"
                        >
                          <code className="min-w-0 flex-1 truncate text-xs text-slate-500">
                            {scope.path}
                          </code>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Remove ${profile.name} from ${scope.path}`}
                            disabled={disabled}
                            onClick={() =>
                              onRemoveScoped(
                                profile.id,
                                scope.path,
                                scope.profiles,
                              )
                            }
                            className="text-slate-600 hover:text-red-300"
                          >
                            <X />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};

export const WorkspaceSettingsPanel = ({
  workspace,
  setup,
  workspaceSetup,
  resetToken,
  identity,
  profiles,
  libraryError,
  libraryAvailable,
  onAssign,
  onRemoveScoped,
  onConfigurationBusyChange,
  onMcpDirtyChange,
}: {
  workspace: ManagedWorkspaceView;
  setup: InstructionManagementControls;
  workspaceSetup: WorkspaceManagementControls;
  resetToken: number;
  identity: WorkspaceIdentityDraft;
  profiles: readonly InstructionProfileView[];
  libraryError: string | null;
  libraryAvailable: boolean;
  onAssign: (profileId: string, assigned: boolean) => void;
  onRemoveScoped: (
    profileId: string,
    path: string,
    profileIds: readonly string[],
  ) => void;
  onConfigurationBusyChange: (busy: boolean) => void;
  onMcpDirtyChange: (dirty: boolean) => void;
}): JSX.Element => (
  <div className="space-y-4">
    <IdentityForm
      draft={identity}
      disabled={setup.saving || !libraryAvailable}
    />
    <InstructionAssignments
      setup={setup}
      profiles={profiles}
      workspace={workspace.instructionWorkspace}
      libraryError={libraryError}
      libraryAvailable={libraryAvailable}
      settingsDirty={identity.dirty}
      onAssign={onAssign}
      onRemoveScoped={onRemoveScoped}
    />
    <WorkspaceConfigurationSettings
      key={`workspace-configuration-${workspace.key}-${resetToken}`}
      workspaceRoot={workspace.root}
      workspaceLabel={getManagedWorkspaceName(workspace)}
      workspaceMemoryDefaultEnabled={
        workspaceSetup.workspaceMemoryDefaultEnabled
      }
      onBusyChange={onConfigurationBusyChange}
      onSaved={workspaceSetup.onConfigurationChanged}
    />
    <WorkspaceMcpSettings
      key={`workspace-mcp-${workspace.key}-${resetToken}`}
      workspaceRoot={workspace.root}
      onDirtyChange={onMcpDirtyChange}
    />
  </div>
);
