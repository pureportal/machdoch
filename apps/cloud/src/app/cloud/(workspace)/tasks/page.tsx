import { TaskList } from "@/components/cloud/task-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function TasksPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <TaskList
      workspace={(await requireCloudWorkspace()).workspace}
      initial={await runtime.execution.runs.list(actor)}
    />
  );
}
