import { TaskList } from "@/components/cloud/task-list";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function TasksPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <TaskList
      workspace={await runtime.planning.workspace(actor)}
      initial={await runtime.execution.runs.list(actor)}
    />
  );
}
