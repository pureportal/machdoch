import { AlertCircle, Cog } from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";

export interface ProviderEmptyStateProps {
  onOpenSettings: () => void;
}

export const ProviderEmptyState = ({
  onOpenSettings,
}: ProviderEmptyStateProps): JSX.Element => {
  return (
    <main className="z-20 flex min-h-0 flex-1 flex-col items-center justify-center bg-slate-950 px-6 py-12 text-center shadow-inner shadow-black/80">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full border border-red-500/20 bg-red-500/10">
        <AlertCircle className="h-10 w-10 text-red-500" />
      </div>
      <h2 className="mb-3 text-2xl font-bold text-slate-100">
        No API Providers Configured
      </h2>
      <p className="mb-8 max-w-md text-sm leading-6 text-slate-400">
        Save at least one provider API key in Settings to unlock the desktop
        shell.
      </p>
      <Button
        type="button"
        onClick={onOpenSettings}
        className="h-11 rounded-xl border border-slate-800 bg-slate-950 px-6 text-white hover:bg-slate-900"
      >
        <Cog className="mr-2 h-4 w-4" />
        Open settings
      </Button>
    </main>
  );
};
