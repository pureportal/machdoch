export const MACHDOCH_CLOUD_SERVER_ID = "machdoch-cloud";

const CONNECTION_TTL_MS = 60_000;
const ISSUE_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT_SEARCHES = 2;

export interface CloudIssueReference {
  identifier: string;
  title: string;
  statusName: string;
  state: string;
}

export interface CloudIssueSource {
  servers: () => Promise<readonly unknown[]>;
  search: (query: string) => Promise<unknown>;
}

export interface CloudIssueDirectory {
  lookup: (key: string) => Promise<CloudIssueReference | null>;
  search: (query: string) => Promise<CloudIssueReference[] | null>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const machdochCloudConnected = (servers: readonly unknown[]): boolean =>
  servers.some((server) => {
    const entry = record(server);
    return entry?.id === MACHDOCH_CLOUD_SERVER_ID && entry.enabled === true;
  });

export const parseCloudIssueSearch = (
  output: unknown,
): CloudIssueReference[] => {
  const result = record(record(output)?.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((part) => record(part))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part!.text as string)
    .join("");
  if (result?.isError === true) {
    const failure = record(JSON.parse(text || "null"));
    throw new Error(
      typeof failure?.error === "string"
        ? failure.error
        : text || "machdoch.cloud could not search issues.",
    );
  }
  const issues: unknown = JSON.parse(text || "[]");
  if (!Array.isArray(issues))
    throw new Error("machdoch.cloud returned an invalid issue list.");
  return issues.flatMap((issue) => {
    const entry = record(issue);
    if (
      typeof entry?.identifier !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.statusName !== "string" ||
      typeof entry.state !== "string"
    )
      return [];
    return [
      {
        identifier: entry.identifier,
        title: entry.title,
        statusName: entry.statusName,
        state: entry.state,
      },
    ];
  });
};

export const createCloudIssueDirectory = (
  source: CloudIssueSource,
  now: () => number = Date.now,
): CloudIssueDirectory => {
  let connection: { checkedAt: number; connected: Promise<boolean> } | null =
    null;
  const issues = new Map<
    string,
    { loadedAt: number; issue: Promise<CloudIssueReference | null> }
  >();
  const waiting: (() => void)[] = [];
  let running = 0;

  const connected = (): Promise<boolean> => {
    if (!connection || now() - connection.checkedAt > CONNECTION_TTL_MS) {
      const checking = source.servers().then(machdochCloudConnected);
      connection = { checkedAt: now(), connected: checking };
      checking.catch(() => {
        connection = null;
      });
    }
    return connection.connected;
  };

  const limited = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (running >= MAX_CONCURRENT_SEARCHES)
      await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await operation();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  const search = async (
    query: string,
  ): Promise<CloudIssueReference[] | null> => {
    const trimmed = query.trim();
    if (!trimmed || !(await connected())) return null;
    return parseCloudIssueSearch(await limited(() => source.search(trimmed)));
  };

  const lookup = (key: string): Promise<CloudIssueReference | null> => {
    const normalized = key.toUpperCase();
    const cached = issues.get(normalized);
    if (cached && now() - cached.loadedAt <= ISSUE_TTL_MS) return cached.issue;
    const issue = search(normalized).then((found) => {
      if (!found) issues.delete(normalized);
      return (
        found?.find((entry) => entry.identifier.toUpperCase() === normalized) ??
        null
      );
    });
    issues.set(normalized, { loadedAt: now(), issue });
    issue.catch(() => issues.delete(normalized));
    return issue;
  };

  return { lookup, search };
};
