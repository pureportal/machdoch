import { useState, type JSX, type ReactNode } from "react";
import { openUrl } from "../media-platform";

export const MediaExternalLink = ({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}): JSX.Element => {
  const [error, setError] = useState(false);
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={className}
        onClick={(event) => {
          event.preventDefault();
          setError(false);
          void openUrl(href).catch(() => setError(true));
        }}
      >
        {children}
      </a>
      {error ? (
        <span role="alert" className="block text-xs text-rose-300">
          The link could not be opened. Copy its address and open it in your
          browser.
        </span>
      ) : null}
    </>
  );
};
