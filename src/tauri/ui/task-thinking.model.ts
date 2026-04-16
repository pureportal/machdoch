import type { RunMode } from "../../core/types.js";
import type { TaskPanelTone } from "./task-panel.model";

export interface TaskThinkingEntry {
  id: string;
  label: string;
  detail: string;
  tone: TaskPanelTone;
  timestamp: number;
}

export interface TaskThinkingTrace {
  status: "running" | "complete";
  mode: RunMode;
  entries: TaskThinkingEntry[];
}
