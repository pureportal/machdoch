import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type JSX,
} from "react";
import { Input } from "../../../components/ui/input";
import { useSettingsNavigationGuard } from "./navigation-guard";

interface SettingsNumberInputProps extends Omit<
  ComponentProps<typeof Input>,
  "value" | "defaultValue" | "onChange" | "type" | "min" | "max" | "step"
> {
  value: number;
  min: number;
  max: number;
  step?: number | string;
  onValueChange: (value: number) => void;
}

export const SettingsNumberInput = ({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  onBlur,
  onKeyDown,
  ...props
}: SettingsNumberInputProps): JSX.Element => {
  const [draft, setDraft] = useState(String(value));
  const [showError, setShowError] = useState(false);
  const previousValue = useRef(value);
  const errorId = useId();
  const number = Number(draft);
  const increment = Math.min(Number(step), 1);
  const steps = number / increment;
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(number) &&
    number >= min &&
    number <= max &&
    (!Number.isFinite(increment) || Math.abs(steps - Math.round(steps)) < 1e-8);
  const dirty = draft !== String(value);
  const error = showError && !valid;

  useEffect(() => {
    const previous = previousValue.current;
    previousValue.current = value;
    setDraft((current) =>
      current === String(previous) ? String(value) : current,
    );
  }, [value]);

  useSettingsNavigationGuard({
    dirty,
    title: "Discard unfinished value?",
    description: "The unfinished number will not be saved.",
    onDiscard: () => {
      setDraft(String(value));
      setShowError(false);
    },
  });

  const commit = (): void => {
    setShowError(!valid);
    if (valid) {
      setDraft(String(number));
      if (number !== value) onValueChange(number);
    }
  };

  return (
    <div className="grid min-w-0 gap-2">
      <Input
        {...props}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-invalid={error || undefined}
        aria-describedby={
          [props["aria-describedby"], error ? errorId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(event) => {
          setDraft(event.target.value);
          setShowError(false);
        }}
        onBlur={(event) => {
          commit();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          onKeyDown?.(event);
        }}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-rose-300">
          Enter {increment === 1 ? "a whole number" : "a number"} from{" "}
          {min.toLocaleString()} to {max.toLocaleString()}
          {increment < 1 ? ` in steps of ${increment}` : ""}.
        </p>
      ) : null}
    </div>
  );
};
