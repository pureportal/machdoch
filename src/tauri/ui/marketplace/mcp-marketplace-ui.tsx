import {
  CheckCircle2,
  Globe2,
  Search,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import type {
  McpMarketplaceCredentialField,
  McpMarketplaceInstallCandidate,
  McpMarketplaceInstallPlan,
} from "../../../core/mcp/marketplace.js";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import type {
  MarketplaceMessage,
  MarketplaceMessageTone,
  MarketplaceView,
} from "./mcp-marketplace-model";

export const PANEL_CLASS =
  "rounded-lg border border-slate-800 bg-slate-950/80";
export const INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600";
export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-sky-500/40 focus:ring-2 focus:ring-sky-500/15 disabled:cursor-not-allowed disabled:opacity-60";

export const VIEW_OPTIONS: ReadonlyArray<{
  id: MarketplaceView;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "discover", label: "Discover", icon: Search },
  { id: "installed", label: "Installed", icon: CheckCircle2 },
  { id: "registries", label: "Registries", icon: Globe2 },
  { id: "advanced", label: "Advanced", icon: Settings2 },
];

export const getCandidateLabel = (
  candidate: McpMarketplaceInstallCandidate,
): string => {
  if (candidate.kind === "remote") {
    return `${candidate.title} (${candidate.transportType})`;
  }

  const version = candidate.packageVersion ? `@${candidate.packageVersion}` : "";
  return `${candidate.registryType ?? candidate.kind}: ${
    candidate.packageIdentifier ?? "package"
  }${version}`;
};

export const getInstallKindLabel = (
  plan: McpMarketplaceInstallPlan,
): string => {
  if (plan.kind === "remote") {
    return plan.candidate.transportType;
  }

  return plan.candidate.registryType ?? plan.kind;
};

const getMessageClass = (tone: MarketplaceMessageTone): string => {
  switch (tone) {
    case "success":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-100";
    case "warning":
      return "border-amber-500/20 bg-amber-500/10 text-amber-100";
    case "error":
      return "border-rose-500/20 bg-rose-500/10 text-rose-100";
    case "info":
      return "border-sky-500/20 bg-sky-500/10 text-sky-100";
  }
};

export const CredentialInput = ({
  field,
  value,
  disabled,
  onChange,
}: {
  field: McpMarketplaceCredentialField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element => {
  if (field.choices && field.choices.length > 0) {
    return (
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select value</option>
        {field.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      value={value}
      type="text"
      disabled={disabled}
      placeholder={
        field.secret
          ? field.placeholder ?? `${field.name.toUpperCase()}_ENV`
          : field.placeholder ?? field.defaultValue ?? ""
      }
      onChange={(event) => onChange(event.target.value)}
      className={INPUT_CLASS}
    />
  );
};

export const StatusMessage = ({
  message,
}: {
  message: MarketplaceMessage | null;
}): JSX.Element | null => {
  if (!message) {
    return null;
  }

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        getMessageClass(message.tone),
      )}
    >
      {message.text}
    </div>
  );
};

export const ServerBadge = ({
  children,
}: {
  children: ReactNode;
}): JSX.Element => {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-slate-800 bg-slate-900 px-2 text-xs font-medium text-slate-300">
      {children}
    </span>
  );
};
