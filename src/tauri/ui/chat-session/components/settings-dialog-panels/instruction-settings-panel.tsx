import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileText,
  FolderPlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import type {
  InstructionMutationInput,
  InstructionProfileView,
} from "../../../runtime";
import { SettingsCard, SettingsStatus } from "./shared";
import type { InstructionSettingsControls } from "./types";

export interface InstructionSettingsPanelProps {
  setup: InstructionSettingsControls;
}

const INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100";
const TEXTAREA_CLASS =
  "min-h-36 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100";

const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";
const asNumber = (value: unknown): number =>
  typeof value === "number" ? value : 0;
const asBoolean = (value: unknown): boolean =>
  typeof value === "boolean" && value;
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
const asArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null,
      )
    : [];

const move = <T,>(values: T[], index: number, delta: -1 | 1): T[] => {
  const target = index + delta;
  if (target < 0 || target >= values.length) return values;
  const next = [...values];
  const current = next[index];
  const replacement = next[target];
  if (current === undefined || replacement === undefined) return values;
  next[index] = replacement;
  next[target] = current;
  return next;
};

const profileLabel = (
  profiles: InstructionProfileView[],
  profileId: string,
): string =>
  profiles.find((profile) => profile.id === profileId)?.name ?? profileId;

const OrderedProfileEditor = ({
  title,
  profiles,
  value,
  disabled,
  onChange,
  onSave,
}: {
  title: string;
  profiles: InstructionProfileView[];
  value: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
  onSave: () => void;
}): JSX.Element => (
  <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        <p className="text-xs text-slate-500">
          Order is precedence order. Later entries win on conflicts.
        </p>
      </div>
      <Button size="sm" disabled={disabled} onClick={onSave} className="gap-2">
        <Save className="size-3.5" />
        Save order
      </Button>
    </div>
    <div className="grid gap-2 md:grid-cols-2">
      {profiles.map((profile) => {
        const selected = value.includes(profile.id);
        return (
          <label
            key={profile.id}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-300"
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled}
              onChange={() =>
                onChange(
                  selected
                    ? value.filter((id) => id !== profile.id)
                    : [...value, profile.id],
                )
              }
            />
            <span className="truncate">{profile.name}</span>
          </label>
        );
      })}
    </div>
    {value.length > 0 ? (
      <div className="space-y-1">
        {value.map((profileId, index) => (
          <div
            key={profileId}
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm"
          >
            <span className="w-6 text-slate-500">{index + 1}.</span>
            <span className="min-w-0 flex-1 truncate text-slate-200">
              {profileLabel(profiles, profileId)}
            </span>
            <Button
              size="icon"
              variant="ghost"
              disabled={disabled || index === 0}
              aria-label="Move profile up"
              onClick={() => onChange(move(value, index, -1))}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={disabled || index === value.length - 1}
              aria-label="Move profile down"
              onClick={() => onChange(move(value, index, 1))}
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    ) : (
      <p className="text-xs text-slate-500">No profiles assigned.</p>
    )}
  </div>
);

export const InstructionSettingsPanel = ({
  setup,
}: InstructionSettingsPanelProps): JSX.Element => {
  const registry = setup.registry;
  const profiles = registry?.profiles ?? [];
  const [query, setQuery] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [defaultOrder, setDefaultOrder] = useState<string[]>([]);
  const [newScopePath, setNewScopePath] = useState("");
  const [newScopeProfiles, setNewScopeProfiles] = useState<string[]>([]);
  const [localScope, setLocalScope] = useState(".");
  const [localBody, setLocalBody] = useState("");
  const [confirmRecoveryReset, setConfirmRecoveryReset] = useState(false);

  useEffect(() => {
    setDefaultOrder([...(registry?.defaults.profiles ?? [])]);
  }, [registry?.revision, registry?.defaults.profiles]);

  const selectedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  useEffect(() => {
    if (!selectedProfile) {
      setName("");
      setDescription("");
      setBody("");
      return;
    }
    setName(selectedProfile.name);
    setDescription(selectedProfile.description ?? "");
    setBody(selectedProfile.body ?? "");
  }, [selectedProfile]);

  useEffect(() => {
    setConfirmRecoveryReset(false);
  }, [registry?.recovery?.primaryDigest]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProfiles = useMemo(
    () =>
      profiles.filter((profile) =>
        normalizedQuery.length === 0
          ? true
          : [
              profile.name,
              profile.description ?? "",
              profile.id,
              profile.digest,
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalizedQuery),
      ),
    [normalizedQuery, profiles],
  );
  const hiddenCount = profiles.length - filteredProfiles.length;

  const selectedProfileImpact = useMemo(() => {
    if (!selectedProfile) return [];
    const impact: string[] = [];
    if (registry?.defaults.profiles.includes(selectedProfile.id)) {
      impact.push("All workspaces · root");
    }
    for (const workspace of registry?.workspaces ?? []) {
      for (const scope of workspace.scopes) {
        if (scope.profiles.includes(selectedProfile.id)) {
          impact.push(
            `${workspace.displayName ?? workspace.root} · ${
              scope.path === "." ? "entire workspace" : scope.path
            }`,
          );
        }
      }
    }
    return impact;
  }, [registry?.defaults.profiles, registry?.workspaces, selectedProfile]);

  const mutate = async (input: InstructionMutationInput): Promise<boolean> =>
    (await setup.onManualSave(input)) !== false;

  const saveProfile = async (): Promise<void> => {
    if (!registry || !name.trim() || !body.trim()) return;
    const ok = await mutate(
      selectedProfile
        ? {
            operation: "profile-edit",
            profileId: selectedProfile.id,
            name,
            description,
            body,
            expectedRevision: registry.revision,
          }
        : {
            operation: "profile-create",
            name,
            description,
            body,
            expectedRevision: registry.revision,
          },
    );
    if (ok) setSelectedProfileId(null);
  };

  const activeWorkspace =
    registry?.workspaces.find(
      (workspace) =>
        setup.workspaceRoot &&
        workspace.root.toLocaleLowerCase() ===
          setup.workspaceRoot.toLocaleLowerCase(),
    ) ?? null;
  const explanationSources = asArray(registry?.resolution?.explanation.sources);
  const nativeInventory = asArray(
    registry?.resolution?.explanation.nativeInventory,
  );
  const mcpInitializationInstructions = asArray(
    registry?.resolution?.explanation.mcpInitializationInstructions,
  );
  const diagnostics = asArray(registry?.resolution?.explanation.diagnostics);
  const bodyGroups = asArray(registry?.resolution?.explanation.bodyGroups);
  const budget = registry?.resolution?.explanation.budget;
  const dimensions = asArray(registry?.resolution?.deliveryPlan.dimensions);
  const recovery = registry?.recovery;
  const recoveryExportCommand = recovery?.backupDigest
    ? `machdoch instructions recovery export --expected-digest ${recovery.backupDigest} --include-content --json`
    : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-xs text-slate-400">
          <Badge variant="secondary">
            {profiles.length} profile{profiles.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="outline">Revision {registry?.revision ?? 0}</Badge>
          <Badge variant="outline">
            {registry?.localFiles.length ?? 0} local
          </Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={setup.loading}
          onClick={() => void setup.onRefresh()}
        >
          <RefreshCw
            className={`size-3.5 ${setup.loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
      <SettingsStatus message={setup.message} />

      {recovery && !recovery.primaryValid ? (
        <SettingsCard
          title="Instruction library recovery"
          description="Restore a validated backup or create a clean library."
          className="border-red-900/70"
        >
          <div className="rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-100">
            <p className="font-medium">
              {recovery.errorCode ?? "INSTRUCTION_LIBRARY_INVALID"}
            </p>
            <p className="mt-1 text-red-200">
              {recovery.errorMessage ??
                registry.libraryError ??
                "The instruction library could not be validated."}
            </p>
          </div>
          <dl className="grid gap-2 text-xs text-slate-400">
            <div>
              <dt className="font-medium text-slate-300">Primary</dt>
              <dd className="break-all font-mono">
                {recovery.libraryPath || "Unavailable path"}
              </dd>
              <dd className="break-all font-mono">
                digest {recovery.primaryDigest ?? "unavailable"}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-300">
                Last-known-valid backup
              </dt>
              <dd className="break-all font-mono">
                {recovery.backupPath || "Unavailable path"}
              </dd>
              <dd className="break-all font-mono">
                {recovery.backupValid
                  ? `revision ${recovery.backupRevision ?? "unknown"} · digest ${
                      recovery.backupDigest ?? "unavailable"
                    }`
                  : "No validated backup is available."}
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-5 text-slate-500">
            Restore and reset both revalidate the reviewed digest immediately
            before writing. Reset preserves the corrupt bytes in a protected
            sidecar before creating an empty library.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={setup.saving || !recovery.backupDigest}
              onClick={() => {
                if (!recovery.backupDigest) return;
                void mutate({
                  operation: "recovery-restore",
                  expectedDigest: recovery.backupDigest,
                });
              }}
            >
              <RefreshCw className="size-3.5" />
              Restore validated backup
            </Button>
            <Button
              size="sm"
              variant={confirmRecoveryReset ? "destructive" : "outline"}
              disabled={setup.saving || !recovery.primaryDigest}
              onClick={() => {
                if (!recovery.primaryDigest) return;
                if (!confirmRecoveryReset) {
                  setConfirmRecoveryReset(true);
                  return;
                }
                void mutate({
                  operation: "recovery-reset",
                  expectedDigest: recovery.primaryDigest,
                });
              }}
            >
              <Trash2 className="size-3.5" />
              {confirmRecoveryReset
                ? "Confirm preserve and reset"
                : "Review empty-library reset"}
            </Button>
          </div>
          {recoveryExportCommand ? (
            <div className="space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3">
              <p className="text-xs leading-5 text-amber-200">
                A portable backup export contains full instruction bodies and
                may contain sensitive information. Run this explicit CLI command
                only after choosing a secure destination.
              </p>
              <code className="block break-all rounded bg-slate-950 p-2 text-[11px] text-slate-300">
                {recoveryExportCommand}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void globalThis.navigator?.clipboard?.writeText(
                    recoveryExportCommand,
                  )
                }
              >
                <Copy className="size-3.5" />
                Copy export command
              </Button>
            </div>
          ) : null}
        </SettingsCard>
      ) : registry?.libraryError ? (
        <SettingsCard
          title="Instruction library unavailable"
          description="The recovery status was loaded, but the library inventory could not be read."
        >
          <p className="rounded-lg border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200">
            {registry.libraryError}
          </p>
        </SettingsCard>
      ) : null}

      {registry?.resolutionError ? (
        <SettingsCard
          title="Resolution unavailable"
          description="Profiles remain editable. Runs need a valid resolution."
        >
          <p className="rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
            {registry.resolutionError}
          </p>
        </SettingsCard>
      ) : null}

      <SettingsCard
        title="Instruction library"
        description="Search, create, and edit reusable Markdown profiles."
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-500" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, description, UUID, or digest"
              className={`${INPUT_CLASS} pl-9`}
            />
          </div>
          {normalizedQuery ? (
            <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
              Clear
            </Button>
          ) : null}
          <Button
            size="sm"
            className="gap-2"
            onClick={() => setSelectedProfileId(null)}
          >
            <Plus className="size-3.5" />
            New profile
          </Button>
        </div>
        {hiddenCount > 0 ? (
          <p className="mb-3 text-xs text-slate-500">
            {hiddenCount} profile{hiddenCount === 1 ? "" : "s"} hidden by the
            current filter.
          </p>
        ) : null}
        <div className="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
            {filteredProfiles.map((profile) => (
              <button
                type="button"
                key={profile.id}
                onClick={() => setSelectedProfileId(profile.id)}
                className={`w-full rounded-xl border p-3 text-left transition ${
                  selectedProfileId === profile.id
                    ? "border-sky-700 bg-sky-950/30"
                    : "border-slate-800 bg-slate-950/50 hover:border-slate-700"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-slate-100">
                    {profile.name}
                  </span>
                  <Badge variant="outline">
                    {profile.assignmentCount} assigned
                  </Badge>
                </div>
                {profile.description ? (
                  <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                    {profile.description}
                  </p>
                ) : null}
                <p className="mt-2 break-all font-mono text-[11px] text-slate-600">
                  {profile.byteLength} bytes · {profile.lineCount} lines ·{" "}
                  {profile.digest}
                </p>
                <p className="mt-1 text-[11px] text-slate-600">
                  Updated {new Date(profile.updatedAt).toLocaleString()}
                </p>
              </button>
            ))}
            {filteredProfiles.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
                No profiles match this filter.
              </p>
            ) : null}
          </div>
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
            <div>
              <p className="text-sm font-semibold text-slate-100">
                {selectedProfile ? "Edit profile" : "Create profile"}
              </p>
              <p className="text-xs text-slate-500">
                The Markdown body is stored once and referenced by UUID.
              </p>
            </div>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Profile name"
              className={INPUT_CLASS}
            />
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional description"
              className={INPUT_CLASS}
            />
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="# Instructions"
              className={TEXTAREA_CLASS}
            />
            {selectedProfile ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                <p className="text-xs font-semibold text-slate-200">
                  Impact preview before save
                </p>
                {selectedProfileImpact.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400">
                    {selectedProfileImpact.map((assignment) => (
                      <li key={assignment}>{assignment}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">
                    This profile is currently unassigned, so editing it changes
                    no workspace resolution until it is assigned.
                  </p>
                )}
                <p className="mt-2 text-[11px] text-slate-500">
                  Existing runs keep their frozen snapshot. Every listed scope
                  uses the new body on its next run.
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2"
                disabled={setup.saving || !name.trim() || !body.trim()}
                onClick={() => void saveProfile()}
              >
                <Save className="size-3.5" />
                {selectedProfile ? "Save profile" : "Create profile"}
              </Button>
              {selectedProfile && registry ? (
                <>
                  <Button
                    variant="outline"
                    className="gap-2"
                    disabled={setup.saving}
                    onClick={() =>
                      void mutate({
                        operation: "profile-duplicate",
                        profileId: selectedProfile.id,
                        expectedRevision: registry.revision,
                      })
                    }
                  >
                    <Copy className="size-3.5" />
                    Duplicate
                  </Button>
                  <Button
                    variant="destructive"
                    className="gap-2"
                    disabled={setup.saving}
                    onClick={() =>
                      void mutate({
                        operation: "profile-delete",
                        profileId: selectedProfile.id,
                        expectedRevision: registry.revision,
                      })
                    }
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsCard>

      {registry ? (
        <SettingsCard
          title="Ordered assignments"
          description="Defaults and folder scopes. Order sets precedence."
        >
          <div className="space-y-4">
            <OrderedProfileEditor
              title="All workspaces"
              profiles={profiles}
              value={defaultOrder}
              disabled={setup.saving}
              onChange={setDefaultOrder}
              onSave={() =>
                void mutate({
                  operation: "defaults-set",
                  profileIds: defaultOrder,
                  expectedRevision: registry.revision,
                })
              }
            />
            <p className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs leading-5 text-slate-500">
              All-workspaces defaults have no negative exceptions. For “all
              except one,” remove the default and assign the profile explicitly
              to each intended workspace root.
            </p>
            {activeWorkspace ? (
              <>
                <WorkspaceBindingEditor
                  workspace={activeWorkspace}
                  revision={registry.revision}
                  saving={setup.saving}
                  mutate={mutate}
                />
                {!activeWorkspace.scopes.some((scope) => scope.path === ".") ? (
                  <ScopeAssignmentEditor
                    workspaceId={activeWorkspace.id}
                    path="."
                    initialProfiles={[]}
                    profiles={profiles}
                    revision={registry.revision}
                    saving={setup.saving}
                    mutate={mutate}
                  />
                ) : null}
                {activeWorkspace.scopes.map((scope) => (
                  <ScopeAssignmentEditor
                    key={scope.path}
                    workspaceId={activeWorkspace.id}
                    path={scope.path}
                    initialProfiles={scope.profiles}
                    profiles={profiles}
                    revision={registry.revision}
                    saving={setup.saving}
                    mutate={mutate}
                  />
                ))}
                <OrderedProfileEditor
                  title={`New folder scope: ${newScopePath || "(enter a relative folder)"}`}
                  profiles={profiles}
                  value={newScopeProfiles}
                  disabled={setup.saving || !newScopePath.trim()}
                  onChange={setNewScopeProfiles}
                  onSave={() =>
                    void mutate({
                      operation: "scope-set",
                      workspaceId: activeWorkspace.id,
                      scopePath: newScopePath,
                      profileIds: newScopeProfiles,
                      expectedRevision: registry.revision,
                    }).then((ok) => {
                      if (ok) {
                        setNewScopePath("");
                        setNewScopeProfiles([]);
                      }
                    })
                  }
                />
                <Input
                  value={newScopePath}
                  onChange={(event) => setNewScopePath(event.target.value)}
                  placeholder='Relative folder, or "." for the entire workspace'
                  className={`${INPUT_CLASS} font-mono`}
                />
              </>
            ) : setup.workspaceRoot ? (
              <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4">
                <p className="text-sm text-amber-200">
                  This workspace is not registered. Defaults and local AGENTS.md
                  still apply.
                </p>
                <Button
                  className="mt-3 gap-2"
                  variant="outline"
                  disabled={setup.saving}
                  onClick={() =>
                    void mutate({
                      operation: "workspace-register",
                      root: setup.workspaceRoot as string,
                      expectedRevision: registry.revision,
                    })
                  }
                >
                  <FolderPlus className="size-3.5" />
                  Register current workspace
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Select a workspace to manage folder assignments.
              </p>
            )}
            {registry.workspaces
              .filter((workspace) => workspace.id !== activeWorkspace?.id)
              .map((workspace) => (
                <div
                  key={workspace.id}
                  className="space-y-3 rounded-xl border border-slate-800/60 p-3"
                >
                  <WorkspaceBindingEditor
                    workspace={workspace}
                    revision={registry.revision}
                    saving={setup.saving}
                    mutate={mutate}
                  />
                  {workspace.scopes.map((scope) => (
                    <ScopeAssignmentEditor
                      key={`${workspace.id}:${scope.path}`}
                      workspaceId={workspace.id}
                      path={scope.path}
                      initialProfiles={scope.profiles}
                      profiles={profiles}
                      revision={registry.revision}
                      saving={setup.saving}
                      mutate={mutate}
                    />
                  ))}
                </div>
              ))}
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard
        title="Project-local instructions"
        description="Root and nested AGENTS.md files in this repository."
      >
        <div className="space-y-3">
          {(registry?.localFiles ?? []).map((file) => (
            <LocalFileEditor
              key={file.id}
              file={file}
              saving={setup.saving}
              mutate={mutate}
            />
          ))}
          <div className="rounded-xl border border-dashed border-slate-800 p-4">
            <p className="mb-3 text-sm font-medium text-slate-200">
              Create AGENTS.md
            </p>
            <div className="grid gap-3 md:grid-cols-[minmax(10rem,0.4fr)_minmax(0,1fr)]">
              <Input
                value={localScope}
                onChange={(event) => setLocalScope(event.target.value)}
                placeholder="."
                className={`${INPUT_CLASS} font-mono`}
              />
              <Textarea
                value={localBody}
                onChange={(event) => setLocalBody(event.target.value)}
                placeholder="# Project instructions"
                className={TEXTAREA_CLASS}
              />
            </div>
            <Button
              className="mt-3 gap-2"
              disabled={setup.saving || !localScope.trim() || !localBody.trim()}
              onClick={() =>
                void mutate({
                  operation: "local-create",
                  scopePath: localScope,
                  body: localBody,
                }).then((ok) => {
                  if (ok) setLocalBody("");
                })
              }
            >
              <FileText className="size-3.5" />
              Create file
            </Button>
          </div>
        </div>
      </SettingsCard>

      {registry?.resolution ? (
        <SettingsCard
          title="Resolution preview"
          description="Current sources and provider delivery for this workspace."
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Delivery"
              value={`${registry.resolution.deliveryPlan.grade} · ${registry.resolution.deliveryPlan.route}`}
            />
            <Metric
              label="Sources"
              value={`${explanationSources.filter((source) => asText(source.status) === "selected").length} selected · ${bodyGroups.length} body groups`}
            />
            <Metric
              label="Instruction budget"
              value={
                budget
                  ? `${asNumber(budget.estimatedTotalInstructionTokens ?? budget.estimatedTokens).toLocaleString()} est. tokens`
                  : "Unavailable"
              }
            />
            <Metric
              label="Library"
              value={`Revision ${registry.resolution.explanation.libraryRevision}`}
            />
          </div>
          <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/30">
            <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-slate-200 hover:text-white">
              Resolution details
            </summary>
            <div className="border-t border-slate-800 px-3 pb-3">
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <Metric
                  label="Canonical digest"
                  value={registry.resolution.explanation.canonicalDigest}
                  mono
                />
                <Metric
                  label="Environment digest"
                  value={registry.resolution.explanation.environmentDigest}
                  mono
                />
                <Metric
                  label="Snapshot"
                  value={registry.resolution.explanation.resolutionId}
                  mono
                />
              </div>
              <div className="mt-5">
                <p className="mb-2 text-sm font-semibold text-slate-200">
                  Effective source/path order
                </p>
                <p className="mb-3 text-xs text-slate-500">
                  Selected and skipped records remain visible. Higher precedence
                  is later in the canonical envelope; structural scope—not task
                  wording—determines applicability.
                </p>
              </div>
              <div className="space-y-2">
                {explanationSources.map((source) => (
                  <div
                    key={asText(source.id)}
                    className="rounded-lg border border-slate-800 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {asNumber(source.precedence)}
                      </Badge>
                      <span className="text-sm text-slate-200">
                        {asText(source.name) || asText(source.id)}
                      </span>
                      <Badge variant="secondary">{asText(source.status)}</Badge>
                      <Badge variant="outline">{asText(source.kind)}</Badge>
                      <Badge variant="outline">
                        {asBoolean(source.trusted)
                          ? "trusted profile/flow"
                          : "repository-controlled"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      Scope <code>{asText(source.scopePath)}</code>
                      {asText(source.assignmentPath)
                        ? ` · assignment ${asText(source.assignmentPath)}`
                        : ""}
                      {asText(source.relativePath)
                        ? ` · origin ${asText(source.relativePath)}`
                        : ""}
                      {asText(source.reason)
                        ? ` · reason ${asText(source.reason)}`
                        : ""}
                    </p>
                    <p className="mt-1 break-all font-mono text-[11px] text-slate-600">
                      {asText(source.id)} · {asNumber(source.byteLength)} bytes
                      · {asNumber(source.lineCount)} lines ·{" "}
                      {asText(source.digest)}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-5">
                <p className="mb-2 text-sm font-semibold text-slate-200">
                  Final body-group order and exact deduplication
                </p>
                {bodyGroups.length > 0 ? (
                  <div className="space-y-2">
                    {bodyGroups.map((group, index) => {
                      const attributions = asArray(group.attributions);
                      return (
                        <div
                          key={`${asText(group.digest)}:${index}`}
                          className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{index + 1}</Badge>
                            <span className="text-xs text-slate-300">
                              Rendered at precedence{" "}
                              {asNumber(group.renderedAtPrecedence)}
                            </span>
                            <span className="text-xs text-slate-500">
                              {asNumber(group.byteLength)} bytes ·{" "}
                              {asNumber(group.lineCount)} lines
                            </span>
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-600">
                            {asText(group.digest)}
                          </p>
                          <div className="mt-2 grid gap-1 md:grid-cols-2">
                            {attributions.map(
                              (attribution, attributionIndex) => (
                                <p
                                  key={`${asText(attribution.sourceId)}:${attributionIndex}`}
                                  className="rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-400"
                                >
                                  {asText(attribution.sourceId)} · scope{" "}
                                  {asText(attribution.scopePath)} · precedence{" "}
                                  {asNumber(attribution.precedence)}
                                </p>
                              ),
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    No instruction bodies are selected for this workspace.
                  </p>
                )}
              </div>
              {budget ? (
                <div className="mt-5">
                  <p className="mb-2 text-sm font-semibold text-slate-200">
                    Exact envelope budget
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <Metric
                      label="Bodies"
                      value={`${asNumber(budget.bodyBytes).toLocaleString()} bytes`}
                    />
                    <Metric
                      label="Envelope + overhead"
                      value={`${asNumber(budget.envelopeBytes).toLocaleString()} bytes · ${asNumber(budget.lineCount).toLocaleString()} lines`}
                    />
                    <Metric
                      label="Runtime supplements"
                      value={`${asNumber(budget.runtimeSupplementBytes).toLocaleString()} bytes`}
                    />
                    <Metric
                      label="Estimated instruction tokens"
                      value={asNumber(
                        budget.estimatedTotalInstructionTokens ??
                          budget.estimatedTokens,
                      ).toLocaleString()}
                    />
                    <Metric
                      label="Provider capacity"
                      value={
                        typeof budget.providerLimitTokens === "number"
                          ? `${asNumber(budget.availableInstructionTokens).toLocaleString()} available after ${asNumber(budget.providerReserveTokens).toLocaleString()} reserve (${asNumber(budget.providerLimitTokens).toLocaleString()} total)`
                          : "Unknown · conservative compatibility"
                      }
                    />
                  </div>
                  {asStringArray(budget.advisories).map((advisory) => (
                    <p
                      key={advisory}
                      className="mt-2 rounded-lg bg-amber-950/20 p-2 text-xs text-amber-200"
                    >
                      Advisory: {advisory}
                    </p>
                  ))}
                  {asStringArray(budget.blockingErrors).map((blockingError) => (
                    <p
                      key={blockingError}
                      className="mt-2 rounded-lg bg-red-950/30 p-2 text-xs text-red-200"
                    >
                      Blocked: {blockingError}
                    </p>
                  ))}
                  <p className="mt-2 text-[11px] text-slate-500">
                    Truncation: none. A source or provider shortfall blocks
                    before invocation and never drops content.
                  </p>
                </div>
              ) : null}
              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-semibold text-slate-200">
                    Delivery dimensions
                  </p>
                  {dimensions.map((dimension) => (
                    <p
                      key={asText(dimension.name)}
                      className="mb-2 rounded-lg bg-slate-950 p-2 text-xs text-slate-400"
                    >
                      <strong className="text-slate-200">
                        {asText(dimension.name)} · {asText(dimension.status)}
                      </strong>
                      <br />
                      {asText(dimension.detail)}
                    </p>
                  ))}
                  <details className="text-xs text-slate-400">
                    <summary className="cursor-pointer text-slate-300">
                      Versioned capability evidence
                    </summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-2 font-mono text-[11px]">
                      {JSON.stringify(
                        registry.resolution.deliveryPlan.capability,
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
                <div>
                  <p className="mb-2 text-sm font-semibold text-slate-200">
                    Native inventory
                  </p>
                  {nativeInventory.length > 0 ? (
                    nativeInventory.map((record) => (
                      <div
                        key={`${asText(record.location)}:${asText(record.path)}`}
                        className="mb-2 rounded-lg bg-slate-950 p-2 text-xs text-slate-400"
                      >
                        <strong className="text-slate-200">
                          {asText(record.status)}
                        </strong>{" "}
                        · {asText(record.location)} ·{" "}
                        {asStringArray(record.recognizingConventions).length > 0
                          ? asStringArray(record.recognizingConventions).join(
                              ", ",
                            )
                          : asText(record.convention)}
                        <p className="break-all font-mono text-[11px] text-slate-500">
                          {asText(record.path)}
                          {asText(record.digest)
                            ? ` · ${asText(record.digest)}`
                            : ""}
                        </p>
                        {asText(record.note) ? (
                          <p className="mt-1">{asText(record.note)}</p>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">
                      No provider-native files inventoried.
                    </p>
                  )}
                  <p className="mb-2 mt-4 text-sm font-semibold text-slate-200">
                    MCP initialization hints
                  </p>
                  {mcpInitializationInstructions.length > 0 ? (
                    mcpInitializationInstructions.map((record, index) => (
                      <div
                        key={`${asText(record.digest)}:${index}`}
                        className="mb-2 rounded-lg bg-slate-950 p-2 text-xs text-slate-400"
                      >
                        Servers: {asStringArray(record.serverIds).join(", ")}
                        <p className="break-all font-mono text-[11px] text-slate-500">
                          {asText(record.byteLength)} bytes ·{" "}
                          {asText(record.digest)}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">
                      No enabled MCP server initialization hints are frozen for
                      this resolution.
                    </p>
                  )}
                </div>
              </div>
              {diagnostics.length > 0 ? (
                <div className="mt-5">
                  <p className="mb-2 text-sm font-semibold text-slate-200">
                    Diagnostics and structural conflicts
                  </p>
                  {diagnostics.map((diagnostic, index) => (
                    <div
                      key={`${asText(diagnostic.code)}:${index}`}
                      className="mb-2 rounded-lg border border-slate-800 p-2 text-xs text-slate-400"
                    >
                      [{asText(diagnostic.severity)}] {asText(diagnostic.code)}:{" "}
                      {asText(diagnostic.message)}
                      {diagnostic.details ? (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-slate-500">
                          {JSON.stringify(diagnostic.details, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        </SettingsCard>
      ) : null}
    </div>
  );
};

const Metric = ({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
    <p className="text-xs text-slate-500">{label}</p>
    <p
      className={`mt-1 break-all text-sm text-slate-200 ${
        mono ? "font-mono text-xs" : ""
      }`}
    >
      {value}
    </p>
  </div>
);

const ScopeAssignmentEditor = ({
  workspaceId,
  path,
  initialProfiles,
  profiles,
  revision,
  saving,
  mutate,
}: {
  workspaceId: string;
  path: string;
  initialProfiles: string[];
  profiles: InstructionProfileView[];
  revision: number;
  saving: boolean;
  mutate: (input: InstructionMutationInput) => Promise<boolean>;
}): JSX.Element => {
  const [value, setValue] = useState([...initialProfiles]);
  const [nextPath, setNextPath] = useState(path);
  useEffect(() => setValue([...initialProfiles]), [initialProfiles, revision]);
  useEffect(() => setNextPath(path), [path, revision]);
  return (
    <div className="space-y-2">
      <OrderedProfileEditor
        title={path === "." ? "Entire workspace" : `Folder scope: ${path}`}
        profiles={profiles}
        value={value}
        disabled={saving}
        onChange={setValue}
        onSave={() =>
          void mutate({
            operation: "scope-set",
            workspaceId,
            scopePath: path,
            profileIds: value,
            expectedRevision: revision,
          })
        }
      />
      <div className="flex flex-col gap-2 rounded-lg border border-slate-800 p-3 sm:flex-row">
        <Input
          value={nextPath}
          onChange={(event) => setNextPath(event.target.value)}
          className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
          aria-label={`Relink folder scope ${path}`}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !nextPath.trim() || nextPath === path}
          onClick={() =>
            void mutate({
              operation: "scope-relink",
              workspaceId,
              currentScopePath: path,
              nextScopePath: nextPath,
              expectedRevision: revision,
            })
          }
        >
          Relink folder
        </Button>
        {initialProfiles.length > 0 ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={saving}
            onClick={() =>
              void mutate({
                operation: "scope-set",
                workspaceId,
                scopePath: path,
                profileIds: [],
                expectedRevision: revision,
              })
            }
          >
            Remove assignment
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const WorkspaceBindingEditor = ({
  workspace,
  revision,
  saving,
  mutate,
}: {
  workspace: {
    id: string;
    root: string;
    displayName?: string;
    scopes: Array<{ path: string; profiles: string[] }>;
  };
  revision: number;
  saving: boolean;
  mutate: (input: InstructionMutationInput) => Promise<boolean>;
}): JSX.Element => {
  const [nextRoot, setNextRoot] = useState(workspace.root);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  useEffect(() => {
    setNextRoot(workspace.root);
    setConfirmRemoval(false);
  }, [workspace.id, workspace.root, revision]);
  const assignmentCount = workspace.scopes.reduce(
    (count, scope) => count + scope.profiles.length,
    0,
  );

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 p-4">
      <div>
        <p className="font-medium text-slate-100">
          {workspace.displayName ?? workspace.root}
        </p>
        <p className="break-all font-mono text-xs text-slate-500">
          {workspace.root} · {workspace.id} · {assignmentCount} assignment
          {assignmentCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={nextRoot}
          onChange={(event) => setNextRoot(event.target.value)}
          className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
          aria-label={`Relink workspace ${workspace.id}`}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !nextRoot.trim() || nextRoot === workspace.root}
          onClick={() =>
            void mutate({
              operation: "workspace-relink",
              workspaceId: workspace.id,
              root: nextRoot,
              expectedRevision: revision,
            })
          }
        >
          Relink workspace
        </Button>
        <Button
          size="sm"
          variant={confirmRemoval ? "destructive" : "outline"}
          disabled={saving}
          onClick={() => {
            if (!confirmRemoval) {
              setConfirmRemoval(true);
              return;
            }
            void mutate({
              operation: "workspace-unregister",
              workspaceId: workspace.id,
              confirmAssignedRemoval: true,
              expectedRevision: revision,
            });
          }}
        >
          {confirmRemoval ? "Confirm unregister" : "Unregister"}
        </Button>
      </div>
      {confirmRemoval ? (
        <p className="text-xs text-amber-300">
          This removes the binding and its {assignmentCount} assignment
          reference{assignmentCount === 1 ? "" : "s"}. Profiles and repository
          files remain unchanged.
        </p>
      ) : null}
    </div>
  );
};

const LocalFileEditor = ({
  file,
  saving,
  mutate,
}: {
  file: {
    scopePath: string;
    relativePath: string;
    body?: string;
    digest: string;
    byteLength: number;
    lineCount: number;
  };
  saving: boolean;
  mutate: (input: InstructionMutationInput) => Promise<boolean>;
}): JSX.Element => {
  const [body, setBody] = useState(file.body ?? "");
  useEffect(() => setBody(file.body ?? ""), [file.body, file.digest]);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="mb-3">
        <p className="font-mono text-sm text-slate-200">{file.relativePath}</p>
        <p className="break-all font-mono text-[11px] text-slate-600">
          {file.byteLength} bytes · {file.lineCount} lines · {file.digest}
        </p>
      </div>
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className={TEXTAREA_CLASS}
      />
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={saving || !body.trim()}
          onClick={() =>
            void mutate({
              operation: "local-edit",
              scopePath: file.scopePath,
              body,
              expectedDigest: file.digest,
            })
          }
        >
          Save file
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={saving}
          onClick={() =>
            void mutate({
              operation: "local-delete",
              scopePath: file.scopePath,
              expectedDigest: file.digest,
            })
          }
        >
          Delete
        </Button>
      </div>
    </div>
  );
};
