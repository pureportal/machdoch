import { ScheduleList } from "@/components/cloud/schedule-list";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function SchedulesPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const [workspace, schedules, status] = await Promise.all([
    runtime.planning.workspace(actor),
    runtime.schedules.list(actor),
    runtime.schedules.status(actor),
  ]);
  return (
    <ScheduleList
      workspace={workspace}
      initial={schedules}
      available={status.available}
    />
  );
}
