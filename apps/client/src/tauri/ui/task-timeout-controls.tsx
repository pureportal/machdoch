import { Clock3, RotateCcw } from "lucide-react";
import { useId, useState, type JSX } from "react";
import { DESKTOP_SETTING_BOUNDS } from "../../core/runtime-contract.generated.js";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import { resetDesktopTaskTimeout } from "./runtime";

export const TaskTimeoutControls = ({
  taskId,
  idleTimeoutMs,
}: {
  taskId: string;
  idleTimeoutMs: number;
}): JSX.Element => {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(String(idleTimeoutMs / 60_000));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duration = Number(minutes);
  const bounds = DESKTOP_SETTING_BOUNDS.chatIdleTimeoutMinutes;
  const valid =
    Number.isInteger(duration) &&
    duration >= bounds.min &&
    duration <= bounds.max;
  const errorMessage =
    error ??
    (valid
      ? null
      : `Enter a whole number from ${bounds.min} to ${bounds.max}.`);

  const resetTimeout = async (idleTimeoutMinutes?: number): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await resetDesktopTaskTimeout(taskId, idleTimeoutMinutes);
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setMinutes(String(idleTimeoutMs / 60_000));
          setError(null);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Adjust chat timeout"
          className="h-7 gap-1.5 px-2 text-[11px]"
        >
          <Clock3 className="h-3.5 w-3.5" />
          Timeout
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !saving) void resetTimeout(duration);
          }}
        >
          <label htmlFor={inputId} className="text-sm font-medium">
            Inactivity (minutes)
          </label>
          <Input
            id={inputId}
            type="number"
            min={bounds.min}
            max={bounds.max}
            step="1"
            required
            aria-invalid={!valid || undefined}
            aria-describedby={errorMessage ? `${inputId}-error` : undefined}
            value={minutes}
            disabled={saving}
            onChange={(event) => {
              setMinutes(event.target.value);
              setError(null);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={saving || !valid}>
              Apply and reset
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void resetTimeout()}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset timer
            </Button>
          </div>
          {errorMessage ? (
            <p
              id={`${inputId}-error`}
              role="alert"
              className="text-sm text-rose-400"
            >
              {errorMessage}
            </p>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
};
