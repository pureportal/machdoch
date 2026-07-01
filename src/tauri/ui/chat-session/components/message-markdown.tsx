import type { JSX } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../_helpers/execution-message.tsx";
import {
  getWorkspaceMarkdownLinkTarget,
  isLocalMarkdownLinkHref,
} from "../_helpers/workspace-markdown-links";

export interface MessageMarkdownProps {
  content: string;
  className?: string;
  workspaceRoot?: string | null;
  onOpenWorkspaceFile?: (relativePath: string) => void;
}

const markdownLinkClassName =
  "font-medium text-sky-300 underline decoration-sky-500/40 underline-offset-4 transition-colors hover:text-sky-100";

const markdownWorkspaceLinkClassName = [
  markdownLinkClassName,
  "inline cursor-pointer border-0 bg-transparent p-0 text-left align-baseline",
].join(" ");

const markdownInertLinkClassName = [
  markdownLinkClassName,
  "cursor-default opacity-80 hover:text-sky-300",
].join(" ");

const messageMarkdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "href" && isLocalMarkdownLinkHref(url)) {
    return url;
  }

  return defaultUrlTransform(url);
};

export const MessageMarkdown = ({
  content,
  className,
  workspaceRoot,
  onOpenWorkspaceFile,
}: MessageMarkdownProps): JSX.Element => {
  return (
    <div
      className={[
        "app-message-markdown grid min-w-0 gap-3 wrap-break-word",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={messageMarkdownUrlTransform}
        components={{
          ...markdownComponents,
          a: ({ children, href, ...props }): JSX.Element => {
            const workspaceTarget = getWorkspaceMarkdownLinkTarget(
              href,
              workspaceRoot,
            );

            if (workspaceTarget && onOpenWorkspaceFile) {
              return (
                <button
                  type="button"
                  title={workspaceTarget.relativePath}
                  onClick={() => onOpenWorkspaceFile(workspaceTarget.relativePath)}
                  className={markdownWorkspaceLinkClassName}
                >
                  {children}
                </button>
              );
            }

            if (!href?.trim() || isLocalMarkdownLinkHref(href)) {
              return (
                <span title={href} className={markdownInertLinkClassName}>
                  {children}
                </span>
              );
            }

            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer"
                className={markdownLinkClassName}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
