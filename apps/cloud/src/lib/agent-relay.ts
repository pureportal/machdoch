export const agentRelaySources = [
  "issue_comment",
  "pull_request_comment",
] as const;
export type AgentRelaySource = (typeof agentRelaySources)[number];

export interface AgentRelay {
  source: AgentRelaySource;
  author: string;
  url: string | null;
}

const agentMention = /(^|[^\w@`/.-])@agent(?![\w-])/i;

export function relayedPrompt(body: string): string | null {
  const match = agentMention.exec(body);
  if (!match) return null;
  const start = match.index + match[1]!.length;
  const prompt = (
    body.slice(0, start) + body.slice(start + 6).replace(/^[ \t,:]+/, "")
  ).trim();
  return prompt || null;
}

export function relayLabel(relay: AgentRelay): string {
  return `${relay.author} relayed by machdoch`;
}
