export interface PullRequestReference {
  identifier: string;
  closes: boolean;
}

export interface PullRequestText {
  branch: string;
  title: string;
  body: string;
}

const closingWords =
  "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|complete|completes|completed";
const referenceWords =
  "ref|refs|references|part of|related to|relates to|contributes to|towards";
const listSeparator = String.raw`(?:\s*(?:,|and|&)\s*)`;

function identifierPattern(keys: readonly string[]): string | null {
  const valid = keys.filter((key) => /^[A-Z][A-Z0-9]{1,9}$/u.test(key));
  return valid.length
    ? String.raw`(?<![A-Za-z0-9])(?:${valid.join("|")})-\d{1,7}(?![A-Za-z0-9])`
    : null;
}

function identifiersIn(text: string, pattern: string): string[] {
  return [...text.matchAll(new RegExp(pattern, "giu"))].map((match) =>
    match[0].toUpperCase(),
  );
}

function keywordIdentifiers(
  text: string,
  pattern: string,
  words: string,
): string[] {
  const list = new RegExp(
    String.raw`\b(?:${words})\b:?\s+((?:${pattern})(?:${listSeparator}(?:${pattern}))*)`,
    "giu",
  );
  return [...text.matchAll(list)].flatMap((match) =>
    identifiersIn(match[1] ?? "", pattern),
  );
}

function referenceCollector() {
  const references = new Map<string, boolean>();
  return {
    add(identifiers: string[], closes: boolean) {
      for (const identifier of identifiers)
        references.set(
          identifier,
          closes || (references.get(identifier) ?? false),
        );
    },
    list(): PullRequestReference[] {
      return [...references].map(([identifier, closes]) => ({
        identifier,
        closes,
      }));
    },
  };
}

export function pullRequestReferences(
  pullRequest: PullRequestText,
  teamKeys: readonly string[],
): PullRequestReference[] {
  const pattern = identifierPattern(teamKeys);
  if (!pattern) return [];
  const references = referenceCollector();
  references.add(identifiersIn(pullRequest.branch, pattern), true);
  references.add(identifiersIn(pullRequest.title, pattern), true);
  references.add(
    keywordIdentifiers(pullRequest.body, pattern, closingWords),
    true,
  );
  references.add(
    keywordIdentifiers(pullRequest.body, pattern, referenceWords),
    false,
  );
  return references.list();
}

export function commitReferences(
  message: string,
  teamKeys: readonly string[],
): PullRequestReference[] {
  const pattern = identifierPattern(teamKeys);
  if (!pattern) return [];
  const references = referenceCollector();
  references.add(keywordIdentifiers(message, pattern, closingWords), true);
  references.add(keywordIdentifiers(message, pattern, referenceWords), false);
  return references.list();
}
