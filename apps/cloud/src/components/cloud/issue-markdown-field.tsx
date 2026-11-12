"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { Pencil } from "lucide-react";
import { CloudMarkdown } from "./cloud-markdown";
import { MarkdownTextarea, type UploadFile } from "./markdown-textarea";
import { toggleTaskListItem } from "@/lib/issue-text";

interface TaskToggle {
  writable: boolean;
  toggle: (offset: number) => void;
}

const TaskToggleContext = createContext<TaskToggle | null>(null);
const TaskOffsetContext = createContext<number | null>(null);

interface MarkdownNode {
  position?: { start: { offset?: number } };
}

function TaskCheckbox({ checked }: { checked: boolean }) {
  const control = useContext(TaskToggleContext);
  const offset = useContext(TaskOffsetContext);
  const interactive = !!control?.writable && offset !== null;
  return (
    <input
      type="checkbox"
      className="cloud-task-checkbox"
      checked={checked}
      disabled={!interactive}
      onChange={() => {
        if (interactive) control.toggle(offset);
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

const markdownComponents = {
  li: ({
    node,
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<"li"> & { node?: MarkdownNode }) => (
    <TaskOffsetContext.Provider
      value={
        className?.includes("task-list-item")
          ? (node?.position?.start.offset ?? null)
          : null
      }
    >
      <li className={className} {...props}>
        {children}
      </li>
    </TaskOffsetContext.Provider>
  ),
  input: ({
    node: _node,
    type,
    checked,
    ...props
  }: ComponentPropsWithoutRef<"input"> & { node?: MarkdownNode }) =>
    type === "checkbox" ? (
      <TaskCheckbox checked={!!checked} />
    ) : (
      <input type={type} checked={checked} {...props} />
    ),
};

export function IssueMarkdownField({
  id,
  label,
  value,
  placeholder,
  writable,
  maxLength,
  className,
  autoEdit = false,
  uploadFile,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  writable: boolean;
  maxLength: number;
  className?: string;
  autoEdit?: boolean;
  uploadFile?: UploadFile;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (!editing || !input.current) return;
    input.current.focus();
    input.current.style.height = "auto";
    input.current.style.height = `${input.current.scrollHeight}px`;
  }, [editing]);
  if (editing)
    return (
      <div className={className}>
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <MarkdownTextarea
          ref={input}
          id={id}
          value={draft}
          maxLength={maxLength}
          placeholder={placeholder}
          uploadFile={uploadFile}
          onChange={(event) => {
            setDraft(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${event.target.scrollHeight}px`;
          }}
          onBlur={() => {
            if (!document.hasFocus()) return;
            setEditing(false);
            if (draft !== value) onSave(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              event.currentTarget.blur();
          }}
        />
      </div>
    );
  if (!value)
    return writable ? (
      <button
        type="button"
        className={`cloud-markdown-placeholder ${className ?? ""}`}
        onClick={() => setEditing(true)}
      >
        {placeholder}
      </button>
    ) : null;
  return (
    <TaskToggleContext.Provider
      value={{
        writable,
        toggle: (offset) => onSave(toggleTaskListItem(value, offset)),
      }}
    >
      <div
        className={`cloud-markdown-view ${className ?? ""}`}
        data-writable={writable || undefined}
        aria-label={label}
        onClick={(event) => {
          if (!writable) return;
          if ((event.target as HTMLElement).closest("a,button,input")) return;
          if (window.getSelection()?.toString()) return;
          setEditing(true);
        }}
      >
        <CloudMarkdown content={value} components={markdownComponents} />
        {writable && (
          <button
            type="button"
            className="cloud-markdown-edit"
            aria-label={`Edit ${label.toLowerCase()}`}
            onClick={() => setEditing(true)}
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
    </TaskToggleContext.Provider>
  );
}
