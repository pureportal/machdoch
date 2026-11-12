"use client";

import { CalendarClock, X } from "lucide-react";

const dueDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function DueDateField({
  id,
  value,
  writable,
  onChange,
}: {
  id: string;
  value: string | null;
  writable: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <span className="cloud-due-date" data-empty={!value || undefined}>
      <label className="cloud-property-value" htmlFor={id}>
        <CalendarClock size={14} aria-hidden="true" />
        <span>
          {value ? dueDate.format(new Date(`${value}T00:00:00Z`)) : "Due date"}
        </span>
        <input
          type="date"
          id={id}
          aria-label="Due date"
          disabled={!writable}
          value={value ?? ""}
          onClick={(event) => event.currentTarget.showPicker()}
          onChange={(event) => onChange(event.target.value || null)}
        />
      </label>
      {writable && value && (
        <button
          type="button"
          className="cloud-due-date-clear"
          aria-label="Clear due date"
          onClick={() => onChange(null)}
        >
          <X size={13} />
        </button>
      )}
    </span>
  );
}
