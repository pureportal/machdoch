import { cn } from "@/lib/utils";

export function PersonAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <span aria-hidden="true" className={cn("cloud-avatar", className)}>
      {initials}
    </span>
  );
}
