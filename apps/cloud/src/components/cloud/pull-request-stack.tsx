import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type { CloudPullRequest } from "@/lib/cloud-git-contract";
import type { StackLink } from "@/lib/pull-request-stacks";

const stateIcons = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const;

function Entry({ link, current }: { link: StackLink; current?: boolean }) {
  const Icon = stateIcons[link.state];
  return (
    <li aria-current={current ? "true" : undefined} data-state={link.state}>
      <Icon size={14} role="img" aria-label={link.state} />
      <span className="cloud-pull-request-muted">#{link.number}</span>
      <span>{link.title}</span>
      <code>{link.headRef}</code>
    </li>
  );
}

export function PullRequestStack({
  pullRequest,
}: {
  pullRequest: CloudPullRequest;
}) {
  const { stack } = pullRequest;
  if (!stack) return null;
  return (
    <section aria-labelledby="pull-request-stack">
      <h3 id="pull-request-stack" className="cloud-pull-request-heading">
        Stack
      </h3>
      <ol className="cloud-pull-request-stack">
        {stack.parent && <Entry link={stack.parent} />}
        <Entry link={pullRequest} current />
        {stack.children.map((child) => (
          <Entry key={child.id} link={child} />
        ))}
      </ol>
    </section>
  );
}
