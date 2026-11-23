"use client";

import { Plus, Repeat, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AutomationInput } from "@/lib/cloud-automation-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLoopSummary } from "@/lib/cloud-loop-contract";
import { holderCan } from "@/lib/cloud-permissions";
import type {
  IssueFilterCondition,
  IssueFilterField,
} from "@/lib/issue-filter-model";
import { placementLabels } from "@/lib/loop-capabilities";
import {
  formatLoopCost,
  groupLoopsByTeam,
  loopFilterFields,
  loopSuccessRate,
  type LoopScope,
} from "@/lib/loop-list";
import { triggerLabel } from "./automation-display";
import { AutomationEditor } from "./automation-editor";
import { AutomationGallery } from "./automation-gallery";
import { AutomationWebhookDialog } from "./automation-webhook-dialog";
import {
  IssueFilterButton,
  IssueFilterChips,
  useFilterTreeState,
} from "./issue-filters";
import { filterFieldDefinitions } from "./issue-filter-fields";
import { LoopTemplateDialog } from "./loop-template-dialog";
import { RelativeTime } from "./relative-time";
import { ScheduleEditor } from "./schedule-editor";
import { Timestamp } from "./timestamp";
import { useAutomationOptions } from "./use-automation-options";

const loopFields: ReadonlySet<IssueFilterField> = new Set(loopFilterFields);

function LoopRow({ loop }: { loop: CloudLoopSummary }) {
  const rate = loopSuccessRate(loop);
  return (
    <tr>
      <th scope="row">
        <Link href={`/cloud/loops/${loop.id}`}>{loop.name}</Link>
        {loop.description && <span>{loop.description}</span>}
      </th>
      <td>
        {loop.killed ? (
          <span className="cloud-task-state" data-state="failed">
            Killed
          </span>
        ) : (
          !loop.enabled && (
            <span className="cloud-task-state" data-state="paused">
              Disabled
            </span>
          )
        )}
      </td>
      <td>
        {loop.kind === "schedule" ? "Schedule" : triggerLabel(loop.trigger)}
      </td>
      <td>{placementLabels[loop.executor.placement]}</td>
      <td>{loop.ownerName}</td>
      <td>{loop.runs}</td>
      <td>{rate === null ? "" : `${rate}%`}</td>
      <td>{formatLoopCost(loop.costCents)}</td>
      <td>
        {loop.lastRunAt && <RelativeTime value={loop.lastRunAt} compact />}
      </td>
      <td>
        {loop.nextRunAt && loop.enabled && !loop.killed && (
          <Timestamp value={loop.nextRunAt} />
        )}
      </td>
    </tr>
  );
}

export function LoopList({
  workspace,
  initial,
}: {
  workspace: CloudWorkspace;
  initial: CloudLoopSummary[];
}) {
  const router = useRouter();
  const options = useAutomationOptions(workspace);
  const [scope, setScope] = useState<LoopScope>("all");
  const [search, setSearch] = useState("");
  const [conditions, setConditions] = useState<IssueFilterCondition[]>([]);
  const [galleryTeam, setGalleryTeam] = useState<string | null>(null);
  const [templateTeam, setTemplateTeam] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationInput | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(
    null,
  );
  const canWrite =
    holderCan(workspace.actor, "automations.edit") &&
    workspace.teams.length > 0;
  const firstTeam = workspace.teams[0]?.id ?? "";
  const definitions = filterFieldDefinitions(
    workspace,
    options.labels,
    null,
  ).filter((definition) => loopFields.has(definition.field));
  const filterState = useFilterTreeState(
    { conditions, groups: [] },
    (tree) => setConditions(tree.conditions),
    definitions,
  );
  const filtered =
    Boolean(search.trim() || conditions.length) || scope === "mine";
  const groups = useMemo(
    () =>
      groupLoopsByTeam(initial, workspace.teams, {
        scope,
        userId: workspace.actor.id,
        search,
        conditions,
        now: new Date(),
      }).filter((group) => group.loops.length),
    [initial, workspace.teams, workspace.actor.id, scope, search, conditions],
  );
  const filterButton = (
    <IssueFilterButton
      fields={filterState.fields}
      selected={filterState.selected}
      onToggle={filterState.toggle}
    />
  );

  return (
    <>
      <header className="cloud-page-header">
        <h1>Loops</h1>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setTemplateTeam(firstTeam)}
            >
              <Sparkles />
              From template
            </Button>
            <Button variant="outline" onClick={() => setScheduling(true)}>
              <Repeat />
              New schedule
            </Button>
            <Button onClick={() => setGalleryTeam(firstTeam)}>
              <Plus />
              New automation
            </Button>
          </div>
        )}
      </header>
      {options.error && <p role="alert">{options.error}</p>}
      <div className="cloud-release-filter" role="group" aria-label="Filter">
        <label className="cloud-pipeline-search">
          <Search size={13} aria-hidden="true" />
          <Input
            type="search"
            value={search}
            placeholder="Filter by name"
            aria-label="Name"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {conditions.length ? (
          <IssueFilterChips
            state={filterState}
            definitions={definitions}
            workspace={workspace}
            onClear={() => setConditions([])}
          >
            {filterButton}
          </IssueFilterChips>
        ) : (
          filterButton
        )}
        <span className="cloud-automation-spacer" />
        <button
          type="button"
          className="cloud-automation-chip"
          aria-pressed={scope === "mine"}
          onClick={() => setScope("mine")}
        >
          My loops
        </button>
        <button
          type="button"
          className="cloud-automation-chip"
          aria-pressed={scope === "all"}
          onClick={() => setScope("all")}
        >
          All loops
        </button>
      </div>
      {!groups.length ? (
        <div className="cloud-empty">
          <Repeat aria-hidden="true" />
          <p>{filtered ? "No matching loops." : "No loops yet."}</p>
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.team.id}
            className="cloud-loop-group"
            aria-label={group.path}
          >
            <header>
              <h2>{group.path}</h2>
              {canWrite && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`New automation in ${group.team.name}`}
                  onClick={() => setGalleryTeam(group.team.id)}
                >
                  <Plus />
                </Button>
              )}
            </header>
            <table className="cloud-pipeline-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">
                    <span className="sr-only">State</span>
                  </th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Runs on</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Success</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Next run</th>
                </tr>
              </thead>
              <tbody>
                {group.loops.map((loop) => (
                  <LoopRow key={loop.id} loop={loop} />
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
      <Dialog
        open={galleryTeam !== null}
        onOpenChange={(open) => !open && setGalleryTeam(null)}
      >
        <DialogContent className="max-w-3xl" aria-describedby={undefined}>
          <DialogTitle>New automation</DialogTitle>
          {galleryTeam !== null && (
            <AutomationGallery
              workspace={workspace}
              options={options}
              teamId={galleryTeam}
              onTeamChange={setGalleryTeam}
              onChoose={(next) => {
                setGalleryTeam(null);
                setDraft(next);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {draft && (
        <AutomationEditor
          workspace={workspace}
          options={options}
          initial={draft}
          onClose={() => setDraft(null)}
          onSaved={async (secret) => {
            if (secret.webhookUrl)
              setCreated({ id: secret.id, url: secret.webhookUrl });
            else router.push(`/cloud/loops/${secret.id}`);
          }}
        />
      )}
      {created && (
        <AutomationWebhookDialog
          url={created.url}
          onClose={() => {
            setCreated(null);
            router.push(`/cloud/loops/${created.id}`);
          }}
        />
      )}
      {scheduling && (
        <ScheduleEditor
          workspace={workspace}
          onClose={() => setScheduling(false)}
          onSaved={async () => router.refresh()}
        />
      )}
      {templateTeam !== null && (
        <LoopTemplateDialog
          workspace={workspace}
          options={options}
          initialTeamId={templateTeam}
          onClose={() => setTemplateTeam(null)}
          onInstalled={(loop) => router.push(`/cloud/loops/${loop.id}`)}
        />
      )}
    </>
  );
}
