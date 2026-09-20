import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui/button";
import { civitaiRuntime } from "../civitai-runtime";
import { openUrl } from "../media-platform";

export function CivitaiSettingsPanel({
  onChanged,
}: {
  onChanged?: (connected: boolean) => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void civitaiRuntime
      .connection()
      .then((value) => {
        if (active) setConnected(value);
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const next = await civitaiRuntime.connect(value);
      setConnected(next);
      setToken("");
      onChanged?.(next);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim()) void save(token);
      }}
    >
      <label className="grid gap-2 text-sm text-slate-300">
        Civitai API key
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          disabled={busy}
          placeholder={
            connected ? "Saved · Enter a new key to replace" : undefined
          }
          onChange={(event) => setToken(event.target.value)}
          className="h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-sky-400"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !token.trim()}>
          {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}Save key
        </Button>
        {connected && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Remove key
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            void openUrl("https://civitai.com/user/account").catch(
              (failure: Error) => setError(failure.message),
            )
          }
        >
          Get API key
        </Button>
      </div>
    </form>
  );
}
