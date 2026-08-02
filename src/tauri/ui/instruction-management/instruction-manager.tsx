import {
  Bot,
  Copy,
  FilePlus2,
  FileText,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { InstructionTagRule } from "../../../core/instruction-system/types.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { SearchField } from "../components/ui/search-field";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import {
  runDesktopTask,
  type InstructionMutationInput,
  type InstructionProfileView,
  type InstructionWorkspaceView,
} from "../runtime";
import type { InstructionSettingsControls } from "../chat-session/components/settings-dialog-panels/types";
import {
  createInstructionAiTask,
  extractInstructionAiBody,
} from "./instruction-ai";
import { TagEditor } from "./tag-editor";
import {
  createEmptyTagGroup,
  isCompleteTagRule,
  TagRuleEditor,
} from "./tag-rule-editor";

type ProfileFilter = "all" | "global" | "automatic" | "manual" | "disabled";

const profileIsEnabled = (profile: InstructionProfileView): boolean =>
  profile.enabled !== false;

const profileTags = (profile: InstructionProfileView): string[] =>
  profile.tags ?? [];

const automaticWorkspaceIds = (profile: InstructionProfileView): string[] =>
  profile.automaticWorkspaceIds ?? [];

const profileHasManualAssignment = (
  profile: InstructionProfileView,
  workspaces: readonly InstructionWorkspaceView[],
): boolean =>
  workspaces.some((workspace) =>
    workspace.scopes.some((scope) => scope.profiles.includes(profile.id)),
  );

const sourceLabels = (
  profile: InstructionProfileView,
  workspaces: readonly InstructionWorkspaceView[],
): string[] => [
  ...(profile.global ? ["Global"] : []),
  ...(profileHasManualAssignment(profile, workspaces) ? ["Manual"] : []),
  ...(automaticWorkspaceIds(profile).length > 0 ? ["Automatic"] : []),
  ...(!profileIsEnabled(profile) ? ["Disabled"] : []),
];

const ProfileSourceBadges = ({
  profile,
  workspaces,
}: {
  profile: InstructionProfileView;
  workspaces: readonly InstructionWorkspaceView[];
}): JSX.Element | null => {
  const labels = sourceLabels(profile, workspaces);
  return labels.length === 0 ? null : (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <Badge
          key={label}
          variant={label === "Disabled" ? "destructive" : "outline"}
          className="px-1.5 py-0 text-[10px]"
        >
          {label}
        </Badge>
      ))}
    </div>
  );
};

const ManualAssignments = ({
  profile,
  workspaces,
  revision,
  disabled,
  mutate,
}: {
  profile: InstructionProfileView;
  workspaces: readonly InstructionWorkspaceView[];
  revision: number;
  disabled: boolean;
  mutate: (input: InstructionMutationInput) => Promise<boolean>;
}): JSX.Element | null => {
  if (workspaces.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Workspaces
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {workspaces.map((workspace) => {
          const rootScope = workspace.scopes.find(
            (scope) => scope.path === ".",
          );
          const assignedScopes = workspace.scopes.filter((scope) =>
            scope.profiles.includes(profile.id),
          );
          const folderScopes = assignedScopes.filter(
            (scope) => scope.path !== ".",
          );
          const checked = rootScope?.profiles.includes(profile.id) ?? false;
          const automatic = automaticWorkspaceIds(profile).includes(
            workspace.id,
          );
          return (
            <div
              key={workspace.id}
              className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2"
            >
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || (profile.global && !checked)}
                  onChange={(event) => {
                    const current = rootScope?.profiles ?? [];
                    void mutate({
                      operation: "scope-set",
                      workspaceId: workspace.id,
                      scopePath: ".",
                      profileIds: event.target.checked
                        ? [...current, profile.id]
                        : current.filter((id) => id !== profile.id),
                      expectedRevision: revision,
                    });
                  }}
                  className="accent-sky-500"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                  {workspace.displayName ??
                    workspace.root.split(/[\\/]/u).at(-1) ??
                    workspace.root}
                </span>
                {automatic ? (
                  <Badge variant="outline" className="text-[10px]">
                    Automatic
                  </Badge>
                ) : null}
              </label>
              {folderScopes.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                  {folderScopes.map((scope) => (
                    <button
                      key={scope.path}
                      type="button"
                      disabled={disabled}
                      aria-label={`Remove ${profile.name} from ${scope.path}`}
                      onClick={() =>
                        void mutate({
                          operation: "scope-set",
                          workspaceId: workspace.id,
                          scopePath: scope.path,
                          profileIds: scope.profiles.filter(
                            (profileId) => profileId !== profile.id,
                          ),
                          expectedRevision: revision,
                        })
                      }
                      className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-slate-800 px-2 py-1 font-mono text-[10px] text-slate-400 hover:border-slate-700 hover:text-slate-200 disabled:opacity-50"
                    >
                      <span className="truncate">{scope.path}</span>
                      <X className="size-3 shrink-0" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export const InstructionManager = ({
  setup,
}: {
  setup: InstructionSettingsControls;
}): JSX.Element => {
  const registry = setup.registry;
  const profiles = registry?.profiles ?? [];
  const localFiles = registry?.localFiles ?? [];
  const workspaces = registry?.workspaces ?? [];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProfileFilter>("all");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [selectedLocalId, setSelectedLocalId] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [creatingLocal, setCreatingLocal] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [global, setGlobal] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [match, setMatch] = useState<InstructionTagRule | null>(null);
  const [localScope, setLocalScope] = useState(".");
  const [aiRequest, setAiRequest] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    void setup.onRefresh();
  }, [setup.onRefresh]);

  useEffect(() => {
    if (
      !creatingProfile &&
      !creatingLocal &&
      !selectedProfileId &&
      !selectedLocalId &&
      profiles[0]
    ) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [
    creatingLocal,
    creatingProfile,
    profiles,
    selectedLocalId,
    selectedProfileId,
  ]);

  const selectedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const selectedLocal =
    localFiles.find((file) => file.id === selectedLocalId) ?? null;

  useEffect(() => {
    if (!selectedProfile) return;
    setName(selectedProfile.name);
    setDescription(selectedProfile.description ?? "");
    setBody(selectedProfile.body ?? "");
    setEnabled(profileIsEnabled(selectedProfile));
    setGlobal(selectedProfile.global === true);
    setTags([...profileTags(selectedProfile)]);
    setMatch(
      selectedProfile.match ? structuredClone(selectedProfile.match) : null,
    );
    setAiRequest("");
    setAiError(null);
  }, [selectedProfile]);

  useEffect(() => {
    if (!selectedLocal) return;
    setLocalScope(selectedLocal.scopePath);
    setBody(selectedLocal.body ?? "");
    setName(selectedLocal.relativePath);
    setDescription("");
    setAiRequest("");
    setAiError(null);
  }, [selectedLocal]);

  const mutate = async (input: InstructionMutationInput): Promise<boolean> =>
    (await setup.onManualSave(input)) !== false;

  const startProfile = (): void => {
    setCreatingProfile(true);
    setCreatingLocal(false);
    setSelectedProfileId(null);
    setSelectedLocalId(null);
    setName("");
    setDescription("");
    setBody("");
    setEnabled(true);
    setGlobal(false);
    setTags([]);
    setMatch(null);
    setAiRequest("");
    setAiError(null);
  };

  const startLocal = (): void => {
    setCreatingLocal(true);
    setCreatingProfile(false);
    setSelectedProfileId(null);
    setSelectedLocalId(null);
    setName("AGENTS.md");
    setDescription("");
    setBody("");
    setLocalScope(".");
    setAiRequest("");
    setAiError(null);
  };

  const selectProfile = (profileId: string): void => {
    setCreatingProfile(false);
    setCreatingLocal(false);
    setSelectedLocalId(null);
    setSelectedProfileId(profileId);
  };

  const selectLocal = (localId: string): void => {
    setCreatingProfile(false);
    setCreatingLocal(false);
    setSelectedProfileId(null);
    setSelectedLocalId(localId);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProfiles = useMemo(
    () =>
      profiles.filter((profile) => {
        const matchesFilter =
          filter === "all" ||
          (filter === "global" && profile.global) ||
          (filter === "automatic" && profile.match !== undefined) ||
          (filter === "manual" &&
            profileHasManualAssignment(profile, workspaces)) ||
          (filter === "disabled" && !profileIsEnabled(profile));
        if (!matchesFilter) return false;
        return (
          !normalizedQuery ||
          [profile.name, profile.description ?? "", ...profileTags(profile)]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        );
      }),
    [filter, normalizedQuery, profiles, workspaces],
  );
  const filteredLocals = localFiles.filter(
    (file) =>
      filter === "all" &&
      (!normalizedQuery ||
        `${file.relativePath} ${file.scopePath}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );

  const saveProfile = async (): Promise<void> => {
    if (!registry || !name.trim() || !body.trim()) return;
    if (!global && match && !isCompleteTagRule(match)) return;
    const ok = await mutate(
      selectedProfile
        ? {
            operation: "profile-edit",
            profileId: selectedProfile.id,
            name,
            description,
            body,
            enabled,
            global,
            tags,
            match: global ? null : match,
            expectedRevision: registry.revision,
          }
        : {
            operation: "profile-create",
            name,
            description,
            body,
            enabled,
            global,
            tags,
            ...(global || match === null ? {} : { match }),
            expectedRevision: registry.revision,
          },
    );
    if (ok) setCreatingProfile(false);
  };

  const saveLocal = async (): Promise<void> => {
    if (!body.trim() || !localScope.trim()) return;
    const ok = await mutate(
      selectedLocal
        ? {
            operation: "local-edit",
            scopePath: selectedLocal.scopePath,
            body,
            expectedDigest: selectedLocal.digest,
          }
        : { operation: "local-create", scopePath: localScope, body },
    );
    if (ok) setCreatingLocal(false);
  };

  const runAiAssist = async (): Promise<void> => {
    if (!name.trim()) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await runDesktopTask(
        setup.workspaceRoot,
        createInstructionAiTask({
          mode: body.trim() ? "improve" : "create",
          name,
          ...(description.trim() ? { description } : {}),
          body,
          ...(aiRequest.trim() ? { request: aiRequest } : {}),
        }),
        { mode: "ask" },
      );
      const response =
        result.execution.response?.markdown ?? result.execution.summary;
      const nextBody = extractInstructionAiBody(response);
      if (!nextBody) {
        throw new Error(
          "AI assistance did not return a complete instruction file.",
        );
      }
      setBody(nextBody);
      setAiRequest("");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  const editingLocal = creatingLocal || selectedLocal !== null;
  const editingProfile = creatingProfile || selectedProfile !== null;
  const recovery = registry?.recovery;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-900 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Instructions</h1>
          <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
            <span>{profiles.length} library</span>
            <span>{localFiles.length} project</span>
            <span>Revision {registry?.revision ?? 0}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startLocal}
          >
            <FilePlus2 className="size-4" />
            Project file
          </Button>
          <Button type="button" size="sm" onClick={startProfile}>
            <Plus className="size-4" />
            Instruction
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={setup.loading}
            aria-label="Refresh instructions"
            onClick={() => void setup.onRefresh()}
          >
            <RefreshCw
              className={cn("size-4", setup.loading && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {setup.message ? (
        <div
          role="status"
          className={cn(
            "shrink-0 border-b px-6 py-2 text-sm",
            setup.message.tone === "error"
              ? "border-red-950 bg-red-950/30 text-red-200"
              : "border-slate-900 bg-slate-900/35 text-slate-300",
          )}
        >
          {setup.message.text}
        </div>
      ) : null}

      {recovery && !recovery.primaryValid ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-red-900/60 bg-red-950/25 px-6 py-3 text-sm text-red-200">
          <span className="min-w-0 flex-1">
            {recovery.errorMessage ?? "Instruction library unavailable."}
          </span>
          {recovery.backupDigest ? (
            <Button
              size="sm"
              variant="outline"
              disabled={setup.saving}
              onClick={() =>
                void mutate({
                  operation: "recovery-restore",
                  expectedDigest: recovery.backupDigest as string,
                })
              }
            >
              Restore
            </Button>
          ) : null}
          {recovery.primaryDigest ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={setup.saving}
              onClick={() => {
                if (
                  !window.confirm(
                    "Preserve the corrupt file and create an empty instruction library?",
                  )
                )
                  return;
                void mutate({
                  operation: "recovery-reset",
                  expectedDigest: recovery.primaryDigest as string,
                });
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(12rem,35vh)_minmax(0,1fr)] lg:grid-cols-[22rem_minmax(0,1fr)] lg:grid-rows-1">
        <aside className="flex min-h-0 min-w-0 flex-col border-r border-slate-900 bg-slate-950/70">
          <div className="shrink-0 space-y-3 border-b border-slate-900 p-4">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search instructions"
              placeholder="Search instructions"
              className="h-9 border-slate-800 bg-slate-950"
            />
            <div className="flex flex-wrap gap-1">
              {(
                ["all", "global", "automatic", "manual", "disabled"] as const
              ).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] capitalize",
                    filter === value
                      ? "bg-sky-500/15 text-sky-200"
                      : "text-slate-500 hover:bg-slate-900 hover:text-slate-200",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {setup.loading && !registry ? (
              <div className="grid h-32 place-items-center text-slate-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
            ) : filteredProfiles.length === 0 && filteredLocals.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No instructions"
                size="compact"
              />
            ) : (
              <div className="space-y-1">
                {filteredProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => selectProfile(profile.id)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2.5 text-left",
                      selectedProfileId === profile.id
                        ? "border-sky-800/70 bg-sky-950/25"
                        : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
                        {profile.name}
                      </span>
                    </div>
                    <div className="mt-1.5 pl-6">
                      <ProfileSourceBadges
                        profile={profile}
                        workspaces={workspaces}
                      />
                    </div>
                  </button>
                ))}
                {filteredLocals.length > 0 ? (
                  <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                    Project files
                  </p>
                ) : null}
                {filteredLocals.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => selectLocal(file.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left",
                      selectedLocalId === file.id
                        ? "border-sky-800/70 bg-sky-950/25"
                        : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                    )}
                  >
                    <FileText className="size-4 shrink-0 text-amber-400/70" />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                      {file.relativePath}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      Local
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 min-w-0 overflow-y-auto">
          {!editingProfile && !editingLocal ? (
            <div className="grid h-full min-h-64 place-items-center p-6">
              <EmptyState
                icon={FileText}
                title="Select an instruction"
                action={
                  <Button size="sm" onClick={startProfile}>
                    <Plus className="size-4" />
                    Instruction
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-5xl space-y-5 p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {editingLocal ? (
                      <FileText className="size-5 text-amber-400/80" />
                    ) : global ? (
                      <Globe2 className="size-5 text-sky-300" />
                    ) : (
                      <FileText className="size-5 text-sky-300" />
                    )}
                    <h2 className="truncate text-base font-semibold text-slate-100">
                      {creatingProfile
                        ? "New instruction"
                        : creatingLocal
                          ? "New project file"
                          : name}
                    </h2>
                  </div>
                  {selectedProfile ? (
                    <div className="mt-2">
                      <ProfileSourceBadges
                        profile={selectedProfile}
                        workspaces={workspaces}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={
                      setup.saving ||
                      !body.trim() ||
                      (!editingLocal &&
                        (!name.trim() ||
                          (!global &&
                            match !== null &&
                            !isCompleteTagRule(match))))
                    }
                    onClick={() =>
                      void (editingLocal ? saveLocal() : saveProfile())
                    }
                  >
                    <Save className="size-4" />
                    Save
                  </Button>
                  {selectedProfile && registry ? (
                    <Button
                      size="icon"
                      variant="outline"
                      disabled={setup.saving}
                      aria-label="Duplicate instruction"
                      onClick={() =>
                        void mutate({
                          operation: "profile-duplicate",
                          profileId: selectedProfile.id,
                          expectedRevision: registry.revision,
                        })
                      }
                    >
                      <Copy className="size-4" />
                    </Button>
                  ) : null}
                  {(selectedProfile || selectedLocal) && registry ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={
                        setup.saving ||
                        Boolean(selectedProfile?.assignmentCount)
                      }
                      aria-label="Delete instruction"
                      title={
                        selectedProfile?.assignmentCount
                          ? "Remove assignments before deleting."
                          : undefined
                      }
                      onClick={() => {
                        if (selectedProfile) {
                          void mutate({
                            operation: "profile-delete",
                            profileId: selectedProfile.id,
                            expectedRevision: registry.revision,
                          });
                        } else if (selectedLocal) {
                          void mutate({
                            operation: "local-delete",
                            scopePath: selectedLocal.scopePath,
                            expectedDigest: selectedLocal.digest,
                          });
                        }
                      }}
                    >
                      <Trash2 className="size-4 text-red-300" />
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                {editingLocal ? (
                  <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                    Scope
                    <Input
                      value={localScope}
                      disabled={Boolean(selectedLocal)}
                      onChange={(event) => setLocalScope(event.target.value)}
                      className="h-9 border-slate-800 bg-slate-950 font-mono"
                    />
                  </label>
                ) : (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                        Name
                        <Input
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          className="h-9 border-slate-800 bg-slate-950"
                        />
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                        Description
                        <Input
                          value={description}
                          onChange={(event) =>
                            setDescription(event.target.value)
                          }
                          className="h-9 border-slate-800 bg-slate-950"
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-5">
                      <label className="flex items-center gap-2 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(event) => setEnabled(event.target.checked)}
                          className="accent-sky-500"
                        />
                        Enabled
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          checked={global}
                          onChange={(event) =>
                            setGlobal(event.target.checked)
                          }
                          className="accent-sky-500"
                        />
                        Global
                      </label>
                    </div>
                    <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                      Tags
                      <TagEditor value={tags} onChange={setTags} />
                    </label>
                  </>
                )}
              </div>

              {!editingLocal && !global ? (
                <section className="rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-slate-200">
                      Automatic match
                    </h3>
                    <label className="flex items-center gap-2 text-sm text-slate-400">
                      <input
                        type="checkbox"
                        checked={match !== null}
                        onChange={(event) =>
                          setMatch(
                            event.target.checked ? createEmptyTagGroup() : null,
                          )
                        }
                        className="accent-sky-500"
                      />
                      Enabled
                    </label>
                  </div>
                  {match ? (
                    <TagRuleEditor value={match} onChange={setMatch} />
                  ) : null}
                </section>
              ) : null}

              <section className="rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Bot className="size-4 text-violet-300" />
                  <h3 className="text-sm font-medium text-slate-200">
                    AI edit
                  </h3>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={aiRequest}
                    disabled={aiBusy}
                    aria-label="AI editing request"
                    placeholder={
                      body.trim() ? "Editing request" : "What should it cover?"
                    }
                    onChange={(event) => setAiRequest(event.target.value)}
                    className="h-9 min-w-0 flex-1 border-slate-800 bg-slate-950"
                  />
                  <Button
                    variant="outline"
                    disabled={aiBusy || !name.trim()}
                    onClick={() => void runAiAssist()}
                  >
                    {aiBusy ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : body.trim() ? (
                      <WandSparkles className="size-4" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {body.trim() ? "Improve" : "Create"}
                  </Button>
                </div>
                {aiError ? (
                  <p className="mt-2 text-sm text-red-300">{aiError}</p>
                ) : null}
              </section>

              <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                Content
                <Textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  spellCheck={false}
                  className="min-h-[24rem] resize-y border-slate-800 bg-slate-950 font-mono text-sm leading-6 text-slate-100"
                />
              </label>

              {selectedProfile && registry ? (
                <ManualAssignments
                  profile={selectedProfile}
                  workspaces={workspaces}
                  revision={registry.revision}
                  disabled={setup.saving}
                  mutate={mutate}
                />
              ) : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
};
