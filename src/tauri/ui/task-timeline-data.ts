import type { TaskExecutionStatus } from "../../core/types.js";
import type { TaskPanelSource, TaskPanelTone } from "./task-panel.model";

export interface TaskTimelineMessage {
  id: string;
  taskId?: string;
  role: "user" | "agent";
  content: string;
  createdAt?: number;
  source?: TaskPanelSource;
}

export interface TaskTimelineEvent {
  id: string;
  label: string;
  description: string;
  tone: TaskPanelTone;
}

export interface TaskTimelineItem {
  id: string;
  taskId: string;
  title: string;
  summary: string;
  statusLabel: string;
  tone: TaskPanelTone;
  modeLabel?: string;
  toolsLabel?: string;
  events: TaskTimelineEvent[];
}

const executionStatusLabels: Record<TaskExecutionStatus, string> = {
  planned: "Plan ready",
  executed: "Executed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  unsupported: "Preview only",
};

const executionStatusTones: Record<TaskExecutionStatus, TaskPanelTone> = {
  planned: "info",
  executed: "success",
  blocked: "danger",
  cancelled: "neutral",
  unsupported: "neutral",
};

const createPreviewStatus = (): { label: string; tone: TaskPanelTone } => {
  return {
    label: "Ready to run",
    tone: "info",
  };
};

const createMessageTimestamp = (
  message: TaskTimelineMessage,
  index: number,
): number => {
  return typeof message.createdAt === "number" ? message.createdAt : index;
};

const createTaskTitle = (messages: TaskTimelineMessage[]): string => {
  for (const message of messages) {
    if (message.source?.kind === "preview") {
      return message.source.preview.task;
    }

    if (message.source?.kind === "execution") {
      return message.source.execution.task;
    }
  }

  const userMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );

  return userMessage?.content.trim() ?? "Untitled task";
};

const createTaskSummary = (messages: TaskTimelineMessage[]): string => {
  for (const message of [...messages].reverse()) {
    if (message.source?.kind === "preview") {
      return message.source.preview.summary;
    }

    if (message.source?.kind === "execution") {
      return message.source.execution.summary;
    }
  }

  const agentMessage = messages.find(
    (message) => message.role === "agent" && message.content.trim().length > 0,
  );

  if (agentMessage) {
    return agentMessage.content.trim();
  }

  const userMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );

  return userMessage?.content.trim() ?? "Awaiting task details.";
};

const createToolsLabel = (source: TaskPanelSource): string | undefined => {
  const tools =
    source.kind === "preview"
      ? source.preview.suggestedTools
      : source.execution.executedTools;

  if (tools.length === 0) {
    return undefined;
  }

  return tools.join(", ");
};

const createEventFromMessage = (
  message: TaskTimelineMessage,
): TaskTimelineEvent => {
  if (message.role === "user") {
    return {
      id: message.id,
      label: "Request submitted",
      description: message.content,
      tone: "info",
    };
  }

  if (message.source?.kind === "preview") {
    const previewStatus = createPreviewStatus();

    return {
      id: message.id,
      label: previewStatus.label,
      description: message.source.preview.summary,
      tone: previewStatus.tone,
    };
  }

  if (message.source?.kind === "execution") {
    return {
      id: message.id,
      label: executionStatusLabels[message.source.execution.status],
      description: message.source.execution.summary,
      tone: executionStatusTones[message.source.execution.status],
    };
  }

  return {
    id: message.id,
    label: "Agent update",
    description: message.content,
    tone: "neutral",
  };
};

const createTaskStatus = (
  messages: TaskTimelineMessage[],
): {
  statusLabel: string;
  tone: TaskPanelTone;
  modeLabel?: string;
  toolsLabel?: string;
} => {
  for (const message of [...messages].reverse()) {
    if (message.source?.kind === "execution") {
      const toolsLabel = createToolsLabel(message.source);

      return {
        statusLabel: executionStatusLabels[message.source.execution.status],
        tone: executionStatusTones[message.source.execution.status],
        modeLabel: message.source.execution.mode,
        ...(toolsLabel ? { toolsLabel } : {}),
      };
    }

    if (message.source?.kind === "preview") {
      const previewStatus = createPreviewStatus();
      const toolsLabel = createToolsLabel(message.source);

      return {
        statusLabel: previewStatus.label,
        tone: previewStatus.tone,
        modeLabel: message.source.preview.mode,
        ...(toolsLabel ? { toolsLabel } : {}),
      };
    }
  }

  return {
    statusLabel: "Queued",
    tone: "neutral",
  };
};

/**
 * Groups task-related chat messages into compact timeline items for the desktop
 * sidebar activity feed.
 */
export const createTaskTimelineModel = (
  messages: TaskTimelineMessage[],
): TaskTimelineItem[] => {
  const groupedMessages = new Map<
    string,
    { taskId: string; messages: TaskTimelineMessage[]; lastCreatedAt: number }
  >();

  messages.forEach((message, index) => {
    const taskId = message.taskId ?? message.id;
    const createdAt = createMessageTimestamp(message, index);
    const existingGroup = groupedMessages.get(taskId);

    if (!existingGroup) {
      groupedMessages.set(taskId, {
        taskId,
        messages: [message],
        lastCreatedAt: createdAt,
      });
      return;
    }

    existingGroup.messages.push(message);
    existingGroup.lastCreatedAt = Math.max(
      existingGroup.lastCreatedAt,
      createdAt,
    );
  });

  return Array.from(groupedMessages.values())
    .map((group) => {
      const orderedMessages = [...group.messages].sort((left, right) => {
        const leftCreatedAt = createMessageTimestamp(left, 0);
        const rightCreatedAt = createMessageTimestamp(right, 0);

        return leftCreatedAt - rightCreatedAt;
      });
      const status = createTaskStatus(orderedMessages);

      return {
        id: group.taskId,
        taskId: group.taskId,
        title: createTaskTitle(orderedMessages),
        summary: createTaskSummary(orderedMessages),
        statusLabel: status.statusLabel,
        tone: status.tone,
        ...(status.modeLabel ? { modeLabel: status.modeLabel } : {}),
        ...(status.toolsLabel ? { toolsLabel: status.toolsLabel } : {}),
        events: orderedMessages.map(createEventFromMessage),
      };
    })
    .sort((left, right) => {
      const leftGroup = groupedMessages.get(left.taskId);
      const rightGroup = groupedMessages.get(right.taskId);

      return (rightGroup?.lastCreatedAt ?? 0) - (leftGroup?.lastCreatedAt ?? 0);
    });
};
