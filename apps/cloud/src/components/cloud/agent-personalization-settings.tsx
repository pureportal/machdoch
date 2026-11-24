"use client";

import { useRef, useState, type FormEvent } from "react";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import { Button } from "@/components/ui/button";
import { createCommandSender } from "./api-client";
import { useToast } from "./toast";

function AgentRepositories({
  repositories,
  initial,
}: {
  repositories: GitRepositoryOption[];
  initial: string[];
}) {
  const [pending, setPending] = useState(false);
  const sender = useRef(createCommandSender());
  const toast = useToast();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const repositoryIds = new FormData(event.currentTarget)
      .getAll("repository")
      .map(String);
    setPending(true);
    try {
      await sender.current(
        "agent-personalization/repositories",
        { repositoryIds },
        "PUT",
      );
      toast("Saved");
    } catch (reason) {
      toast((reason as Error).message, "error");
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="cloud-settings-section cloud-setting-form"
      onSubmit={submit}
    >
      <fieldset className="cloud-check-grid">
        <legend>Allowed repositories</legend>
        {repositories.map((repository) => (
          <label key={repository.id}>
            <input
              type="checkbox"
              name="repository"
              value={repository.id}
              defaultChecked={initial.includes(repository.id)}
            />
            {repository.fullName}
          </label>
        ))}
      </fieldset>
      <p className="cloud-agent-muted">None checked allows all.</p>
      <Button type="submit" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

export function AgentPersonalizationSettings({
  repositoryIds,
  repositories,
}: {
  repositoryIds: string[];
  repositories: GitRepositoryOption[];
}) {
  if (repositories.length === 0) return null;
  return (
    <AgentRepositories repositories={repositories} initial={repositoryIds} />
  );
}
