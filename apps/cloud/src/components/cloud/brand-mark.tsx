import {
  Anchor,
  Aperture,
  Atom,
  Bird,
  Box,
  Code,
  Command,
  Compass,
  Cpu,
  Crown,
  Feather,
  Flame,
  Gem,
  Globe,
  Heart,
  Hexagon,
  Infinity as InfinityIcon,
  Layers,
  Leaf,
  Moon,
  Mountain,
  Orbit,
  Puzzle,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Sun,
  Target,
  Telescope,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { brandShapeRadius, type BrandThemeColors } from "@/lib/brand-palette";
import type { CloudOrganization } from "@/lib/cloud-administration-contract";
import { organizationInitials, type BrandIcon } from "@/lib/organization-brand";
import { cn } from "@/lib/utils";

export const brandIconComponents: Record<BrandIcon, LucideIcon> = {
  command: Command,
  sparkles: Sparkles,
  rocket: Rocket,
  zap: Zap,
  layers: Layers,
  hexagon: Hexagon,
  box: Box,
  compass: Compass,
  globe: Globe,
  leaf: Leaf,
  flame: Flame,
  mountain: Mountain,
  star: Star,
  heart: Heart,
  shield: Shield,
  cpu: Cpu,
  code: Code,
  feather: Feather,
  anchor: Anchor,
  atom: Atom,
  gem: Gem,
  sun: Sun,
  moon: Moon,
  waves: Waves,
  infinity: InfinityIcon,
  bird: Bird,
  orbit: Orbit,
  target: Target,
  crown: Crown,
  puzzle: Puzzle,
  aperture: Aperture,
  telescope: Telescope,
};

export type BrandIdentity = Pick<CloudOrganization, "name" | "brand" | "logo">;

export function BrandMark({
  identity,
  colors,
  className,
}: {
  identity: BrandIdentity;
  colors?: BrandThemeColors;
  className?: string;
}) {
  const { brand, logo, name } = identity;
  const Icon = brandIconComponents[brand.icon];
  const style = colors
    ? ({
        "--cloud-brand-fill": colors.gradient
          ? `linear-gradient(135deg, ${colors.primary}, ${colors.gradient})`
          : colors.primary,
        "--primary-foreground": colors.foreground,
        "--cloud-brand-radius": brandShapeRadius[brand.shape],
      } as CSSProperties)
    : undefined;
  const image = brand.mark === "image" && logo;
  return (
    <span
      aria-hidden="true"
      className={cn("cloud-brand-mark", className)}
      data-image={image ? "" : undefined}
      style={style}
    >
      {image ? (
        <img src={logo} alt="" />
      ) : brand.mark === "initials" ? (
        <span className="cloud-brand-initials">
          {organizationInitials(name, brand.initials)}
        </span>
      ) : (
        <Icon strokeWidth={2.4} />
      )}
    </span>
  );
}
