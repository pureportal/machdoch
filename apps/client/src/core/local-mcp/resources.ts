import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { callLocalTool, readRecords, readText } from "./tool-values.js";
import type { LocalToolRuntime } from "./runtime.js";

const SCHEME = "machdoch:";
const STATE_URI = "machdoch://state";
const MAX_COMPLETION_VALUES = 100;

interface ResourceEntry {
  id: string;
  title: string;
  description?: string;
}

interface ResourceCollection {
  key: string;
  title: string;
  description: string;
  listTool: string;
  listArguments?: Record<string, unknown>;
  readTool: string;
  readArgument: string;
  mimeType: string;
  toEntries: (value: unknown) => ResourceEntry[];
  toText?: (value: unknown) => string;
}

const toEntries =
  (idField: string, titleField: string, descriptionField?: string) =>
  (value: unknown): ResourceEntry[] =>
    readRecords(value).flatMap((record) => {
      const id = readText(record, idField);
      if (!id) return [];
      const description = descriptionField
        ? readText(record, descriptionField)
        : undefined;
      return [
        {
          id,
          title: readText(record, titleField) ?? id,
          ...(description ? { description } : {}),
        },
      ];
    });

const COLLECTIONS: ResourceCollection[] = [
  {
    key: "skills",
    title: "Skill",
    description: "Instructions of an enabled Machdoch skill.",
    listTool: "list_managed_skills",
    readTool: "read_managed_skill",
    readArgument: "name",
    mimeType: "text/markdown",
    toEntries: toEntries("name", "name", "description"),
    toText: (value) => {
      const content =
        typeof value === "object" && value !== null && "content" in value
          ? value.content
          : undefined;
      if (typeof content !== "string")
        throw new McpError(ErrorCode.InternalError, "The skill has no content.");
      return content;
    },
  },
  {
    key: "workflows",
    title: "Workflow",
    description: "A saved workspace workflow and its revision fingerprint.",
    listTool: "list_workflows",
    readTool: "read_workflow",
    readArgument: "id",
    mimeType: "application/json",
    toEntries: toEntries("id", "name", "description"),
  },
  {
    key: "workflow-runs",
    title: "Workflow run",
    description: "A workspace workflow run and its current status.",
    listTool: "list_workflow_runs",
    readTool: "read_workflow_run",
    readArgument: "runId",
    mimeType: "application/json",
    toEntries: toEntries("id", "flowName", "summary"),
  },
  {
    key: "research-projects",
    title: "Research project",
    description: "A research project with findings, evidence and revision.",
    listTool: "list_research_projects",
    readTool: "read_research_project",
    readArgument: "id",
    mimeType: "application/json",
    toEntries: toEntries("id", "title", "question"),
  },
  {
    key: "chats",
    title: "Chat",
    description: "The latest saved and queued messages of a Machdoch chat.",
    listTool: "list_chat_sessions",
    listArguments: { limit: 50 },
    readTool: "read_chat_session",
    readArgument: "sessionId",
    mimeType: "application/json",
    toEntries: (value) =>
      toEntries(
        "id",
        "title",
      )(
        typeof value === "object" && value !== null && "sessions" in value
          ? value.sessions
          : [],
      ),
  },
];

const createUri = (collection: ResourceCollection, id: string): string =>
  `machdoch://${collection.key}/${encodeURIComponent(id)}`;

const createUriTemplate = (collection: ResourceCollection): string =>
  `machdoch://${collection.key}/{${collection.readArgument}}`;

const parseUri = (uri: string): { key: string; id?: string } => {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid resource URI: ${uri}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== SCHEME || segments.length > 1 || url.search || url.hash)
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  const id = segments[0] ? decodeURIComponent(segments[0]) : undefined;
  return { key: url.hostname, ...(id ? { id } : {}) };
};

export const createLocalMcpResources = (runtime: LocalToolRuntime) => {
  const available = new Set(
    runtime.definitions.map((definition) => definition.spec.name),
  );
  const collections = COLLECTIONS.filter(
    (collection) =>
      available.has(collection.listTool) && available.has(collection.readTool),
  );
  const stateAvailable = available.has("get_machdoch_state");

  const listEntries = async (
    collection: ResourceCollection,
    signal?: AbortSignal,
  ): Promise<ResourceEntry[]> =>
    collection.toEntries(
      await callLocalTool(
        runtime,
        collection.listTool,
        collection.listArguments ?? {},
        signal,
      ),
    );

  return {
    enabled: stateAvailable || collections.length > 0,

    async list(signal?: AbortSignal): Promise<Resource[]> {
      const listed = await Promise.all(
        collections.map(async (collection) =>
          (await listEntries(collection, signal)).map(
            (entry): Resource => ({
              uri: createUri(collection, entry.id),
              name: entry.id,
              title: `${collection.title}: ${entry.title}`,
              mimeType: collection.mimeType,
              ...(entry.description ? { description: entry.description } : {}),
            }),
          ),
        ),
      );
      return [
        ...(stateAvailable
          ? [
              {
                uri: STATE_URI,
                name: "state",
                title: "Machdoch state",
                description:
                  "Active agents, workspaces, running configurations, and terminals.",
                mimeType: "application/json",
              },
            ]
          : []),
        ...listed.flat(),
      ];
    },

    templates(): ResourceTemplate[] {
      return collections.map((collection) => ({
        uriTemplate: createUriTemplate(collection),
        name: collection.key,
        title: collection.title,
        description: collection.description,
        mimeType: collection.mimeType,
      }));
    },

    async read(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
      if (uri === STATE_URI && stateAvailable) {
        const value = await callLocalTool(
          runtime,
          "get_machdoch_state",
          {},
          signal,
        );
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(value, null, 2),
            },
          ],
        };
      }
      const { key, id } = parseUri(uri);
      const collection = collections.find((entry) => entry.key === key);
      if (!collection || !id)
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
      const value = await callLocalTool(
        runtime,
        collection.readTool,
        { [collection.readArgument]: id },
        signal,
      );
      return {
        contents: [
          {
            uri,
            mimeType: collection.mimeType,
            text: collection.toText
              ? collection.toText(value)
              : JSON.stringify(value, null, 2),
          },
        ],
      };
    },

    async complete(
      uriTemplate: string,
      argumentName: string,
      value: string,
      signal?: AbortSignal,
    ): Promise<{ values: string[]; total: number; hasMore: boolean }> {
      const collection = collections.find(
        (entry) =>
          createUriTemplate(entry) === uriTemplate &&
          entry.readArgument === argumentName,
      );
      if (!collection) return { values: [], total: 0, hasMore: false };
      const query = value.toLowerCase();
      const matches = (await listEntries(collection, signal))
        .filter(
          (entry) =>
            entry.id.toLowerCase().startsWith(query) ||
            entry.title.toLowerCase().includes(query),
        )
        .map((entry) => entry.id);
      return {
        values: matches.slice(0, MAX_COMPLETION_VALUES),
        total: matches.length,
        hasMore: matches.length > MAX_COMPLETION_VALUES,
      };
    },
  };
};

export type LocalMcpResources = ReturnType<typeof createLocalMcpResources>;
