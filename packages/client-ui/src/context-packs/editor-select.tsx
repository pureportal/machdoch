import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Select } from "radix-ui";
import { useCommandOverlay } from "@machdoch/media-studio/tauri/ui/commands/use-command-overlay.js";

export function PackSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  useCommandOverlay({
    open,
    id: `pack-select:${id}`,
    kind: "non-modal",
    dismiss: () => setOpen(false),
  });
  return (
    <div className="app-pack-field">
      <label htmlFor={id}>{label}</label>
      <Select.Root
        value={value}
        onValueChange={onChange}
        open={open}
        onOpenChange={setOpen}
      >
        <Select.Trigger id={id} className="app-pack-control app-pack-select">
          <Select.Value />
          <Select.Icon>
            <ChevronDown size={16} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="app-pack-select-menu"
            position="popper"
            sideOffset={6}
            collisionPadding={12}
          >
            <Select.Viewport role="group" aria-label={label} tabIndex={0}>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="app-pack-select-option"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={16} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
