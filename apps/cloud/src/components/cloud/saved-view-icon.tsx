import {
  Bookmark,
  Bug,
  Eye,
  Flag,
  Inbox,
  Layers,
  Rocket,
  Star,
  Target,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SavedViewIcon as SavedViewIconName } from "@/lib/cloud-view-contract";

const savedViewIconComponents: Record<SavedViewIconName, LucideIcon> = {
  bookmark: Bookmark,
  layers: Layers,
  star: Star,
  flag: Flag,
  bug: Bug,
  rocket: Rocket,
  zap: Zap,
  target: Target,
  inbox: Inbox,
  eye: Eye,
};

export function SavedViewIcon({
  icon,
  size = 14,
}: {
  icon: SavedViewIconName;
  size?: number;
}) {
  const Icon = savedViewIconComponents[icon];
  return <Icon size={size} aria-hidden="true" />;
}
