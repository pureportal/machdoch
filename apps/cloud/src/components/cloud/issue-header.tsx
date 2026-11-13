"use client";

import { holderCan } from "@/lib/cloud-permissions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  GitBranch,
  Hash,
  Laptop,
  Link2,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import {
  availableIssueAgentActions,
  issueAgentActions,
} from "@/lib/agent-quick-actions";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import {
  issueBranchName,
  issueClientPrompt,
  issueSessionTitle,
} from "@/lib/issue-text";
import { Button } from "@/components/ui/button";
import { FavoriteButton } from "./favorite-button";
import { ClientLaunch } from "./client-launch";
import { PropertyMenu } from "./property-menu";
import { useToast } from "./toast";
import { useAgentShell } from "./agent/agent-shell";

export const issueNavigationKey = "machdoch.cloud.issue-navigation";
const openChat = "chat";

function useIssueNavigation(issueId: string) {
  const [list, setList] = useState<{ ids: string[]; href: string } | null>(
    null,
  );
  useEffect(() => {
    try {
      const stored = JSON.parse(
        sessionStorage.getItem(issueNavigationKey) ?? "null",
      ) as { ids: string[]; href: string } | null;
      setList(stored && stored.ids.includes(issueId) ? stored : null);
    } catch {
      setList(null);
    }
  }, [issueId]);
  if (!list) return null;
  const index = list.ids.indexOf(issueId);
  return {
    index,
    total: list.ids.length,
    previous: index > 0 ? list.ids[index - 1]! : null,
    next: index < list.ids.length - 1 ? list.ids[index + 1]! : null,
  };
}

export function IssueHeader({
  issue,
  workspace,
  favorite,
  writable,
  saveState,
  onArchive,
  delegate,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  favorite: boolean;
  writable: boolean;
  saveState: string;
  onArchive: () => void;
  delegate: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const agent = useAgentShell();
  const navigation = useIssueNavigation(issue.id);
  const team = workspace.teams.find((entry) => entry.id === issue.teamId)!;
  const project = workspace.projects.find(
    (entry) => entry.id === issue.projectId,
  );
  const cycle = workspace.cycles.find((entry) => entry.id === issue.cycleId);
  useEffect(() => {
    if (!navigation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      const destination =
        event.key === "j" || event.key === "ArrowDown"
          ? navigation.next
          : event.key === "k" || event.key === "ArrowUp"
            ? navigation.previous
            : null;
      if (!destination) return;
      event.preventDefault();
      router.push(`/cloud/issues/${destination}`);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigation, router]);
  function copy(value: string, label: string) {
    void navigator.clipboard
      .writeText(value)
      .then(() => toast(`${label} copied`))
      .catch(() => toast("Copy failed", "error"));
  }
  return (
    <header className="cloud-issue-header">
      <nav className="cloud-issue-breadcrumb" aria-label="Issue location">
        <Link href={`/cloud/issues?teamId=${team.id}`}>{team.name}</Link>
        <ChevronRight size={13} aria-hidden="true" />
        {project && (
          <>
            <Link href={`/cloud/projects/${project.id}`}>{project.name}</Link>
            <ChevronRight size={13} aria-hidden="true" />
          </>
        )}
        {!project && cycle && (
          <>
            <Link href={`/cloud/cycles/${cycle.id}`}>{cycle.name}</Link>
            <ChevronRight size={13} aria-hidden="true" />
          </>
        )}
        <h1 className="cloud-issue-key">{issue.identifier}</h1>
        <span className="cloud-issue-breadcrumb-title">{issue.title}</span>
        <FavoriteButton kind="issue" id={issue.id} initial={favorite} />
        {writable && (
          <PropertyMenu
            label="Issue actions"
            options={[
              {
                value: "archive",
                label: issue.archived ? "Restore issue" : "Archive issue",
                icon: issue.archived ? (
                  <ArchiveRestore size={14} />
                ) : (
                  <Archive size={14} />
                ),
              },
            ]}
            onSelect={onArchive}
          >
            <button
              type="button"
              className="cloud-icon-button"
              aria-label="Issue actions"
            >
              <Ellipsis size={14} />
            </button>
          </PropertyMenu>
        )}
        {issue.archived && <span className="cloud-issue-flag">Archived</span>}
        <span role="status" className="cloud-issue-save-state">
          {saveState}
        </span>
      </nav>
      <div className="cloud-issue-actions">
        <button
          type="button"
          className="cloud-icon-button"
          aria-label="Copy issue link"
          onClick={() => copy(location.href, "Link")}
        >
          <Link2 size={14} />
        </button>
        <button
          type="button"
          className="cloud-icon-button"
          aria-label="Copy issue ID"
          onClick={() => copy(issue.identifier, "ID")}
        >
          <Hash size={14} />
        </button>
        <button
          type="button"
          className="cloud-icon-button"
          aria-label="Copy branch name"
          onClick={() =>
            copy(issueBranchName(issue.identifier, issue.title), "Branch name")
          }
        >
          <GitBranch size={14} />
        </button>
        {navigation && (
          <span className="cloud-issue-navigation">
            <span>
              {navigation.index + 1} / {navigation.total}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next issue"
              aria-keyshortcuts="J"
              disabled={!navigation.next}
              onClick={() =>
                navigation.next &&
                router.push(`/cloud/issues/${navigation.next}`)
              }
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous issue"
              aria-keyshortcuts="K"
              disabled={!navigation.previous}
              onClick={() =>
                navigation.previous &&
                router.push(`/cloud/issues/${navigation.previous}`)
              }
            >
              <ChevronUp />
            </Button>
          </span>
        )}
        {delegate}
        {holderCan(workspace.actor, "clients.manage") && (
          <ClientLaunch
            label="Open in client"
            icon={<Laptop />}
            branch={issueBranchName(issue.identifier, issue.title)}
            draft={() => ({
              title: issueSessionTitle(issue.identifier, issue.title),
              prompt: issueClientPrompt(
                issue,
                `${location.origin}/cloud/issues/${issue.id}`,
              ),
            })}
          />
        )}
        <PropertyMenu
          label="Ask Agent"
          align="end"
          options={[
            ...(writable
              ? availableIssueAgentActions(workspace.actor).map((action) => ({
                  value: action.id,
                  label: action.label,
                  icon: <Sparkles size={14} aria-hidden="true" />,
                }))
              : []),
            {
              value: openChat,
              label: "Open chat",
              icon: <MessageSquare size={14} aria-hidden="true" />,
            },
          ]}
          onSelect={(value) => {
            const action = issueAgentActions.find(
              (entry) => entry.id === value,
            );
            if (action)
              agent.openPanel(null, action.prompt(issue.identifier), true);
            else agent.openPanel(null);
          }}
        >
          <Button variant="ghost" size="sm">
            <Sparkles />
            Agent
          </Button>
        </PropertyMenu>
      </div>
    </header>
  );
}
