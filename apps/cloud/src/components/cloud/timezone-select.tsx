"use client";

import type { ComponentProps } from "react";
import { Select } from "@/components/ui/select";

const zones = Intl.supportedValuesOf("timeZone");

function zoneLabel(zone: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  return `${zone.replaceAll("_", " ")} (${offset})`;
}

export function TimezoneSelect(
  props: Omit<ComponentProps<typeof Select>, "children">,
) {
  const current = String(props.value ?? props.defaultValue ?? "");
  return (
    <Select {...props}>
      {current && !zones.includes(current) && (
        <option value={current}>{current}</option>
      )}
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zoneLabel(zone)}
        </option>
      ))}
    </Select>
  );
}
