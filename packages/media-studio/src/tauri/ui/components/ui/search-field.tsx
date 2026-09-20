import { Search } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Input } from "./input";

export interface SearchFieldProps extends Omit<
  ComponentProps<typeof Input>,
  "type"
> {
  containerClassName?: string;
  iconClassName?: string;
  endAdornment?: ReactNode;
}

export const SearchField = ({
  containerClassName,
  iconClassName,
  endAdornment,
  className,
  ...props
}: SearchFieldProps): JSX.Element => {
  return (
    <div
      data-slot="search-field"
      className={cn("relative", containerClassName)}
    >
      <Search
        aria-hidden="true"
        data-slot="search-field-icon"
        className={cn(
          "pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500",
          iconClassName,
        )}
      />
      <Input
        type="search"
        className={cn("pl-9", endAdornment && "pr-9", className)}
        {...props}
      />
      {endAdornment ? (
        <span
          data-slot="search-field-end"
          className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center text-slate-500"
        >
          {endAdornment}
        </span>
      ) : null}
    </div>
  );
};
