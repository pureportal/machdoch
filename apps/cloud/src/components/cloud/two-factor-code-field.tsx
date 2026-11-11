import type * as React from "react";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";

export function TwoFactorCodeField({
  id,
  label,
  recovery = false,
  disabled = false,
  autoFocus = false,
  inputRef,
}: {
  id: string;
  label: string;
  recovery?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Input
        ref={inputRef}
        id={id}
        name={id}
        required
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
        autoCapitalize="none"
        className="font-mono tracking-widest"
        {...(recovery
          ? { autoComplete: "off", maxLength: 24 }
          : {
              autoComplete: "one-time-code",
              inputMode: "numeric" as const,
              pattern: "[0-9 \\-]{6,7}",
              title: "6-digit code",
              maxLength: 7,
            })}
      />
    </Field>
  );
}
