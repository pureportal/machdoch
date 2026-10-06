export function selectFleetSessionWindow<T extends { id: string }>(
  sessions: T[],
  activeSessionId: string,
  limit: number,
): T[] {
  const selected = sessions.slice(0, limit);
  if (selected.some(({ id }) => id === activeSessionId)) return selected;
  const active = sessions.find(({ id }) => id === activeSessionId);
  if (active)
    selected[selected.length < limit ? selected.length : limit - 1] = active;
  return selected;
}
