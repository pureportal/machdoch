"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import type { AutomationTrigger } from "@/lib/cloud-automation-contract";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import {
  gitEventKinds,
  isPullRequestEvent,
  type GitEventKind,
} from "@/lib/git-events";
import { ChipToggle } from "./automation-chips";
import { gitEventLabels } from "./automation-display";

type GitTrigger = Extract<AutomationTrigger, { kind: "git_event" }>;

const textEvents = new Set<GitEventKind>([
  "push",
  "comment_created",
  "review_approved",
  "review_changes_requested",
  "review_commented",
]);

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ListInput({
  label,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState(values.join(", "));
  return (
    <Input
      aria-label={label}
      placeholder={placeholder}
      maxLength={2_000}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(parseList(event.target.value));
      }}
      onBlur={() => setDraft(parseList(draft).join(", "))}
    />
  );
}

export function GitTriggerFields({
  trigger,
  repositories,
  onChange,
}: {
  trigger: GitTrigger;
  repositories: GitRepositoryOption[];
  onChange: (trigger: GitTrigger) => void;
}) {
  const events = (kinds: readonly GitEventKind[]) =>
    kinds.map((kind) => ({ value: kind, label: gitEventLabels[kind] }));
  const setEvents = (pullRequests: boolean, selected: string[]) =>
    onChange({
      ...trigger,
      events: [
        ...trigger.events.filter(
          (event) => isPullRequestEvent(event) !== pullRequests,
        ),
        ...(selected as GitEventKind[]),
      ],
    });
  const pullRequestSelected = trigger.events.some(isPullRequestEvent);
  return (
    <>
      <ChipToggle
        label="Repository events"
        options={events(
          gitEventKinds.filter((kind) => !isPullRequestEvent(kind)),
        )}
        selected={trigger.events.filter((event) => !isPullRequestEvent(event))}
        onChange={(selected) => setEvents(false, selected)}
      />
      <ChipToggle
        label="Pull request events"
        options={events(gitEventKinds.filter(isPullRequestEvent))}
        selected={trigger.events.filter(isPullRequestEvent)}
        onChange={(selected) => setEvents(true, selected)}
      />
      {repositories.length > 1 && (
        <ChipToggle
          label="Repositories"
          options={repositories.map((repository) => ({
            value: repository.id,
            label: repository.fullName,
          }))}
          selected={trigger.repositoryIds}
          onChange={(repositoryIds) => onChange({ ...trigger, repositoryIds })}
        />
      )}
      <div className="cloud-automation-row">
        <ListInput
          label={pullRequestSelected ? "Branch or base branch" : "Branch"}
          placeholder={
            pullRequestSelected ? "All target branches" : "All branches"
          }
          values={trigger.branches}
          onChange={(branches) => onChange({ ...trigger, branches })}
        />
        {pullRequestSelected && (
          <ListInput
            label="Source branch"
            placeholder="All source branches"
            values={trigger.headBranches}
            onChange={(headBranches) => onChange({ ...trigger, headBranches })}
          />
        )}
      </div>
      <p className="cloud-automation-hint">
        Separate branches with commas. Use * for any name, ! to exclude and
        $default for the default branch.
      </p>
      <div className="cloud-automation-row">
        <ListInput
          label="By"
          placeholder="Anyone"
          values={trigger.actors}
          onChange={(actors) => onChange({ ...trigger, actors })}
        />
        {trigger.events.some((event) => textEvents.has(event)) && (
          <Input
            aria-label="Contains"
            placeholder="Contains text, such as @agent"
            maxLength={200}
            value={trigger.contains}
            onChange={(event) =>
              onChange({ ...trigger, contains: event.target.value })
            }
          />
        )}
      </div>
    </>
  );
}
