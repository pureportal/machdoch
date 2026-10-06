import type {
  SessionIndexPage,
  SessionIndexQuery,
} from "@machdoch/fleet-protocol/session-data";

export interface SessionDataSource {
  index(query: SessionIndexQuery): Promise<SessionIndexPage>;
  export(sessionIds: string[]): Promise<unknown>;
  import(file: File): Promise<void>;
}
