const formatElapsed = (elapsedMs: number): string => {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
};

/** A moment before the task reached the agent: its time and how long before delivery it was. */
export const describeMomentBeforeDelivery = (
  at: number,
  deliveredAt: number,
): string =>
  `${new Date(at).toISOString()}, ${formatElapsed(Math.max(0, deliveredAt - at))} before delivery`;
