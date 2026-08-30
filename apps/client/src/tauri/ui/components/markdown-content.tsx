import { Check, Clipboard } from "lucide-react";
import {
  defaultMarkdownUrlTransform,
  MarkdownRenderer,
  type MarkdownComponents as Components,
  type MarkdownOptions as ReactMarkdownOptions,
  type MarkdownUrlTransform as UrlTransform,
} from "@machdoch/product-ui";
import {
  isValidElement,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import remarkGfm from "remark-gfm";
import {
  createWorkspacePathLinkRemarkPlugin,
  getWorkspaceMarkdownLinkTarget,
  isLocalMarkdownLinkHref,
  openWorkspaceMarkdownLinkTarget,
  type WorkspaceMarkdownLinkOpenHandler,
} from "./workspace-markdown-links";
import { cn } from "../lib/utils";
import { MermaidDiagram } from "./mermaid-diagram";
import { Button } from "./ui/button";
import { ControlTooltip } from "./ui/tooltip";

export interface MarkdownContentProps {
  content: string;
  className?: string;
  workspaceRoot?: string | null;
  onOpenWorkspaceFile?: WorkspaceMarkdownLinkOpenHandler;
  components?: Components;
}

const getReactNodeText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getReactNodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getReactNodeText(node.props.children);
  }

  return "";
};

const getStructuredFindingsField = (
  children: ReactNode,
): string | undefined => {
  const text = getReactNodeText(children).trimStart();
  const match =
    /^(severity|location|issue|evidence|impact|recommendation)\s*:/iu.exec(
      text,
    );

  return match?.[1]?.toLowerCase();
};

const copyTextToClipboard = async (text: string): Promise<void> => {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";

  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command was rejected.");
    }
  } finally {
    textarea.remove();
  }
};

const CopyableCodeBlock = ({
  children,
}: {
  children?: ReactNode;
}): JSX.Element => {
  const [hasCopied, setHasCopied] = useState(false);
  const resetCopiedTimeout = useRef<number | null>(null);
  const codeBlockText = getReactNodeText(children).replace(/\n$/u, "");

  useEffect(() => {
    return () => {
      if (resetCopiedTimeout.current !== null) {
        window.clearTimeout(resetCopiedTimeout.current);
      }
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(codeBlockText);
      setHasCopied(true);

      if (resetCopiedTimeout.current !== null) {
        window.clearTimeout(resetCopiedTimeout.current);
      }

      resetCopiedTimeout.current = window.setTimeout(() => {
        setHasCopied(false);
        resetCopiedTimeout.current = null;
      }, 1_500);
    } catch {
      setHasCopied(false);
    }
  };

  return (
    <div className="app-markdown-code-block group relative min-w-0">
      <pre className="m-0 max-w-full overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 pr-12 text-xs leading-6 text-slate-200">
        {children}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={
          hasCopied ? "Copied code block" : "Copy code block to clipboard"
        }
        tooltip={hasCopied ? "Copied" : "Copy to clipboard"}
        tooltipProps={{ side: "left" }}
        onClick={handleCopy}
        className="absolute right-2 top-2 size-7 border border-slate-700/70 bg-slate-900/90 p-0 text-slate-300 shadow-sm opacity-90 hover:bg-slate-800 hover:text-sky-100 focus-visible:ring-sky-400/40"
      >
        {hasCopied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Clipboard className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
};

const getMermaidCodeBlockSource = (children: ReactNode): string | null => {
  const codeElement =
    Array.isArray(children) && children.length === 1 ? children[0] : children;

  if (
    !isValidElement<{
      children?: ReactNode;
      className?: string;
    }>(codeElement) ||
    !codeElement.props.className
      ?.split(/\s+/u)
      .some((className) => /^language-mermaid$/iu.test(className))
  ) {
    return null;
  }

  return getReactNodeText(codeElement.props.children).replace(/\n$/u, "");
};

const createMarkdownUrlTransform =
  (
    workspaceRoot: string | null | undefined,
    onOpenWorkspaceFile: WorkspaceMarkdownLinkOpenHandler | undefined,
  ): UrlTransform =>
  (url, key) => {
    if (
      key === "href" &&
      (onOpenWorkspaceFile || workspaceRoot) &&
      getWorkspaceMarkdownLinkTarget(url, workspaceRoot)
    ) {
      return url;
    }

    return defaultMarkdownUrlTransform(url);
  };

const createMarkdownComponents = (
  workspaceRoot: string | null | undefined,
  onOpenWorkspaceFile: WorkspaceMarkdownLinkOpenHandler | undefined,
): Components => ({
  p: ({ children, className, node: _node, ...props }): JSX.Element => {
    const structuredField = getStructuredFindingsField(children);

    return (
      <p
        {...props}
        data-md-field={structuredField}
        className={cn("app-markdown-paragraph", className)}
      >
        {children}
      </p>
    );
  },
  pre: ({ children }): JSX.Element => {
    const mermaidSource = getMermaidCodeBlockSource(children);
    const codeBlock = <CopyableCodeBlock>{children}</CopyableCodeBlock>;

    return mermaidSource === null ? (
      codeBlock
    ) : (
      <MermaidDiagram source={mermaidSource} fallback={codeBlock} />
    );
  },
  code: ({ children, className, node: _node, ...props }): JSX.Element => (
    <code {...props} className={cn("app-markdown-code", className)}>
      {children}
    </code>
  ),
  table: ({ children, className, node: _node, ...props }): JSX.Element => (
    <div
      role="region"
      aria-label="Markdown table"
      tabIndex={0}
      className="app-markdown-table-scroll"
    >
      <table {...props} className={cn("app-markdown-table", className)}>
        {children}
      </table>
    </div>
  ),
  img: ({ src, alt, className, node: _node, ...props }): JSX.Element | null => {
    if (!src?.trim()) {
      return alt ? (
        <span
          role="img"
          aria-label={alt}
          className="app-markdown-image-fallback"
        >
          {alt}
        </span>
      ) : null;
    }

    return (
      <img
        {...props}
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={cn("app-markdown-image", className)}
      />
    );
  },
  a: ({ children, href, className, node: _node, ...props }): JSX.Element => {
    const workspaceTarget = getWorkspaceMarkdownLinkTarget(href, workspaceRoot);

    if (workspaceTarget && onOpenWorkspaceFile) {
      const targetTitle = workspaceTarget.line
        ? `${workspaceTarget.relativePath}:${workspaceTarget.line}`
        : workspaceTarget.relativePath;

      return (
        <ControlTooltip content={targetTitle}>
          <button
            type="button"
            data-workspace-path={workspaceTarget.relativePath}
            data-workspace-line={workspaceTarget.line}
            onClick={() =>
              openWorkspaceMarkdownLinkTarget(
                workspaceTarget,
                onOpenWorkspaceFile,
              )
            }
            className={cn(
              "app-markdown-link app-markdown-workspace-link",
              className,
            )}
          >
            {children}
          </button>
        </ControlTooltip>
      );
    }

    if (!href?.trim() || isLocalMarkdownLinkHref(href)) {
      const inertLink = (
        <span
          className={cn("app-markdown-link app-markdown-inert-link", className)}
        >
          {children}
        </span>
      );

      return href ? (
        <ControlTooltip content={href}>{inertLink}</ControlTooltip>
      ) : (
        inertLink
      );
    }

    const opensNewContext = !href.startsWith("#");

    return (
      <a
        {...props}
        href={href}
        target={opensNewContext ? "_blank" : undefined}
        rel={opensNewContext ? "noopener noreferrer" : undefined}
        className={cn("app-markdown-link", className)}
      >
        {children}
      </a>
    );
  },
});

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
  workspaceRoot,
  onOpenWorkspaceFile,
  components: componentOverrides,
}: MarkdownContentProps): JSX.Element {
  const markdownInstanceId = useId().replace(/[^A-Za-z0-9_-]/gu, "");
  const autoLinkWorkspacePaths = Boolean(onOpenWorkspaceFile);
  const remarkPlugins = useMemo<
    NonNullable<ReactMarkdownOptions["remarkPlugins"]>
  >(
    () =>
      autoLinkWorkspacePaths
        ? [remarkGfm, createWorkspacePathLinkRemarkPlugin(workspaceRoot)]
        : [remarkGfm],
    [autoLinkWorkspacePaths, workspaceRoot],
  );
  const urlTransform = useMemo<UrlTransform>(
    () => createMarkdownUrlTransform(workspaceRoot, onOpenWorkspaceFile),
    [onOpenWorkspaceFile, workspaceRoot],
  );
  const remarkRehypeOptions = useMemo<
    NonNullable<ReactMarkdownOptions["remarkRehypeOptions"]>
  >(
    () => ({ clobberPrefix: `markdown-${markdownInstanceId}-` }),
    [markdownInstanceId],
  );
  const components = useMemo<Components>(
    () => ({
      ...createMarkdownComponents(workspaceRoot, onOpenWorkspaceFile),
      ...componentOverrides,
    }),
    [componentOverrides, onOpenWorkspaceFile, workspaceRoot],
  );

  return (
    <div
      className={cn(
        "app-markdown min-w-0 leading-6 wrap-break-word",
        className,
      )}
    >
      <MarkdownRenderer
        content={content}
        remarkPlugins={remarkPlugins}
        remarkRehypeOptions={remarkRehypeOptions}
        urlTransform={urlTransform}
        components={components}
      />
    </div>
  );
});
