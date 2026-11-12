"use client";

import Link from "next/link";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import { issueLinkRemarkPlugin } from "@/lib/issue-links";

type MarkdownComponents = NonNullable<
  ComponentProps<typeof MarkdownContent>["components"]
>;

const TeamKeysContext = createContext<readonly string[]>([]);

export function TeamKeysProvider({
  keys,
  children,
}: {
  keys: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <TeamKeysContext.Provider value={keys}>{children}</TeamKeysContext.Provider>
  );
}

const linkComponents: MarkdownComponents = {
  a: ({ href, children }) =>
    href?.startsWith("/") ? (
      <Link className="app-markdown-link" href={href}>
        {children}
      </Link>
    ) : (
      <a
        className="app-markdown-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
};

export function CloudMarkdown({
  content,
  className,
  components,
}: {
  content: string;
  className?: string;
  components?: MarkdownComponents;
}) {
  const keys = useContext(TeamKeysContext);
  const remarkPlugins = useMemo(() => [issueLinkRemarkPlugin(keys)], [keys]);
  const merged = useMemo(
    () => ({ ...linkComponents, ...components }),
    [components],
  );
  return (
    <MarkdownContent
      content={content}
      className={className}
      remarkPlugins={remarkPlugins}
      components={merged}
    />
  );
}
