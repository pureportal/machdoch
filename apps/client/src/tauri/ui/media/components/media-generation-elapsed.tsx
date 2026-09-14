import { useEffect, useState, type JSX } from "react";

export const MediaGenerationElapsed = ({
  startedAt,
  completedAt,
}: {
  startedAt: string;
  completedAt: string | null;
}): JSX.Element => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (completedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [completedAt]);
  const seconds = Math.max(
    0,
    Math.floor(
      ((completedAt ? Date.parse(completedAt) : now) - Date.parse(startedAt)) /
        1000,
    ),
  );
  return (
    <span aria-label="Elapsed time" className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
};
