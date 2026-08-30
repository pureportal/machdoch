import { Check, Clipboard } from "lucide-react";
import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type Options as ReactMarkdownOptions,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownComponents = Components;
export type MarkdownOptions = ReactMarkdownOptions;
export type MarkdownUrlTransform = UrlTransform;
export const defaultMarkdownUrlTransform = defaultUrlTransform;

export function MarkdownRenderer({
  content,
  components,
  remarkPlugins,
  remarkRehypeOptions,
  urlTransform,
}: {
  content: string;
  components?: Components;
  remarkPlugins?: ReactMarkdownOptions["remarkPlugins"];
  remarkRehypeOptions?: ReactMarkdownOptions["remarkRehypeOptions"];
  urlTransform?: UrlTransform;
}): React.ReactElement {
  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={remarkPlugins}
      remarkRehypeOptions={remarkRehypeOptions}
      urlTransform={urlTransform}
    >
      {content}
    </ReactMarkdown>
  );
}

export function ProductMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={["app-markdown", className].filter(Boolean).join(" ")}>
      <MarkdownRenderer
        content={content}
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <CopyableCodeBlock>{children}</CopyableCodeBlock>
          ),
          table: ({ children, node: _node, ...props }) => (
            <div
              className="m-markdown-table-scroll"
              role="region"
              aria-label="Markdown table"
              tabIndex={0}
            >
              <table {...props} className="m-markdown-table">
                {children}
              </table>
            </div>
          ),
          a: ({ children, href, node: _node, ...props }) => (
            <a
              {...props}
              href={href}
              target={href?.startsWith("#") ? undefined : "_blank"}
              rel={href?.startsWith("#") ? undefined : "noopener noreferrer"}
            >
              {children}
            </a>
          ),
          img: ({ node: _node, ...props }) => (
            <img
              {...props}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
          ),
        }}
      />
    </div>
  );
}

function CopyableCodeBlock({
  children,
}: {
  children?: ReactNode;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const text = getNodeText(children).replace(/\n$/u, "");

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copy = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="m-markdown-code-block">
      <pre>{children}</pre>
      <button
        type="button"
        className="m-markdown-copy"
        aria-label={copied ? "Copied code block" : "Copy code block"}
        title={copied ? "Copied" : "Copy code block"}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check aria-hidden="true" />
        ) : (
          <Clipboard aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function getNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (["string", "number", "bigint"].includes(typeof node)) return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }
  return "";
}
