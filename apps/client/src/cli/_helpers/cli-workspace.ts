import { homedir } from "node:os";
import { resolve } from "node:path";

export const resolveCliWorkspaceRoot = (workspaceRoot: string): string =>
  resolve(workspaceRoot || homedir());
