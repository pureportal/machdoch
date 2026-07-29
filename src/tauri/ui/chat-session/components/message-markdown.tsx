import { memo, useMemo, type JSX } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type Options as ReactMarkdownOptions,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../_helpers/execution-message.tsx";
import {
  createWorkspacePathLinkRemarkPlugin,
  getWorkspaceMarkdownLinkTarget,
  isLocalMarkdownLinkHref,
  openWorkspaceMarkdownLinkTarget,
  type WorkspaceMarkdownLinkOpenHandler,
} from "../_helpers/workspace-markdown-links";

export interface MessageMarkdownProps {
  content: string;
  className?: string;
  workspaceRoot?: string | null;
  onOpenWorkspaceFile?: WorkspaceMarkdownLinkOpenHandler;
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

export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  className,
  workspaceRoot,
  onOpenWorkspaceFile,
}: MessageMarkdownProps): JSX.Element {
  const remarkPlugins = useMemo<
    NonNullable<ReactMarkdownOptions["remarkPlugins"]>
  >(
    () => [remarkGfm, createWorkspacePathLinkRemarkPlugin(workspaceRoot)],
    [workspaceRoot],
  );
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      table: ({ children, node: _node, ...props }): JSX.Element => (
        <div
          role="region"
          aria-label="Markdown table"
          tabIndex={0}
          className="app-message-table-scroll"
        >
          <table {...props} className="app-message-table">
            {children}
          </table>
        </div>
      ),
      a: ({ children, href, ...props }): JSX.Element => {
        const workspaceTarget = getWorkspaceMarkdownLinkTarget(
          href,
          workspaceRoot,
        );

        if (workspaceTarget && onOpenWorkspaceFile) {
          const targetTitle = workspaceTarget.line
            ? `${workspaceTarget.relativePath}:${workspaceTarget.line}`
            : workspaceTarget.relativePath;

          return (
            <button
              type="button"
              title={targetTitle}
              data-workspace-path={workspaceTarget.relativePath}
              data-workspace-line={workspaceTarget.line}
              onClick={() =>
                openWorkspaceMarkdownLinkTarget(
                  workspaceTarget,
                  onOpenWorkspaceFile,
                )
              }
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
    }),
    [onOpenWorkspaceFile, workspaceRoot],
  );

  return (
    <div
      className={[
        "app-message-markdown min-w-0 leading-6 wrap-break-word",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={messageMarkdownUrlTransform}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
