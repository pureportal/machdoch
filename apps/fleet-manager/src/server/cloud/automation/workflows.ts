import {
  continueAsNew,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

const activities = proxyActivities<{ tickSchedules(): Promise<number> }>({
  startToCloseTimeout: "60 seconds",
  retry: { initialInterval: "2 seconds", maximumInterval: "1 minute" },
});

export async function scheduleCoordinator(): Promise<void> {
  for (let iteration = 0; iteration < 2000; iteration++) {
    const processed = await activities.tickSchedules();
    await sleep(processed >= 5 ? "1 second" : "5 seconds");
    if (workflowInfo().continueAsNewSuggested) break;
  }
  await continueAsNew<typeof scheduleCoordinator>();
}
