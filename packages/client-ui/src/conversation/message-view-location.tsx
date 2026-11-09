import { MapPin } from "lucide-react";
import type { JSX } from "react";

export const MessageViewLocation = ({
  location,
}: {
  location: readonly string[];
}): JSX.Element => {
  const label = location.join(" › ");
  return (
    <p
      aria-label={`Sent from ${label}`}
      title={label}
      className="app-message-view-location inline-flex h-6 max-w-[88%] min-w-0 items-center gap-1 rounded-full border border-slate-800 bg-slate-950/70 px-2 text-[11px] text-slate-400"
    >
      <MapPin aria-hidden="true" className="size-3 shrink-0 text-sky-300" />
      <span className="truncate">{label}</span>
    </p>
  );
};
