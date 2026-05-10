import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../_helpers/execution-message.tsx";

export interface MessageMarkdownProps {
  content: string;
}

export const MessageMarkdown = ({
  content,
}: MessageMarkdownProps): JSX.Element => {
  return (
    <div className="app-message-markdown grid min-w-0 gap-3 wrap-break-word">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
