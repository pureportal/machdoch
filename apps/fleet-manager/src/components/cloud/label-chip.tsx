import type { CloudLabel } from "@/lib/cloud-label-contract";

const colors = {
  gray: "#94a3b8",
  blue: "#60a5fa",
  green: "#4ade80",
  yellow: "#facc15",
  orange: "#fb923c",
  red: "#f87171",
  purple: "#c084fc",
  pink: "#f472b6",
} satisfies Record<CloudLabel["color"], string>;

export function LabelChip({ label }: { label: CloudLabel }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1 text-sm">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colors[label.color] }}
      />
      <span className="break-words">{label.name}</span>
      {label.archived && (
        <span className="text-xs text-muted-foreground">Archived</span>
      )}
    </span>
  );
}
