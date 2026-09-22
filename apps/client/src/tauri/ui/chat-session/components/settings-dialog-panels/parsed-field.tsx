import { useEffect, useState, type JSX } from "react";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";

interface ParsedFieldProps<T> {
  value: unknown;
  format: (value: unknown) => string;
  parse: (text: string) => T;
  onChange: (value: T) => void;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function ParsedField<T>({
  value,
  format,
  parse,
  onChange,
  multiline = false,
  disabled,
  placeholder,
  className,
}: ParsedFieldProps<T>): JSX.Element {
  const formattedValue = format(value);
  const [edit, setEdit] = useState<{
    raw: string;
    formatted: string;
  } | null>(null);
  const displayedValue =
    edit?.formatted === formattedValue ? edit.raw : formattedValue;

  useEffect(() => {
    if (edit && edit.formatted !== formattedValue) {
      setEdit(null);
    }
  }, [edit, formattedValue]);

  const update = (raw: string): void => {
    const parsed = parse(raw);
    setEdit({ raw, formatted: format(parsed) });
    onChange(parsed);
  };

  const commonProps = {
    value: displayedValue,
    disabled,
    placeholder,
    className,
    onBlur: () => setEdit(null),
  };

  return multiline ? (
    <Textarea
      {...commonProps}
      onChange={(event) => update(event.target.value)}
    />
  ) : (
    <Input {...commonProps} onChange={(event) => update(event.target.value)} />
  );
}
