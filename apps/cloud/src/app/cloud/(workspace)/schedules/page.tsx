import { ScheduleList } from "@/components/cloud/schedule-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function SchedulesPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const [workspace, schedules, status] = await Promise.all([
    requireCloudWorkspace().then(({ workspace }) => workspace),
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
