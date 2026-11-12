"use client";

import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Strikethrough,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useRef } from "react";
import {
  continueList,
  insertLink,
  pasteLink,
  toggleInline,
  toggleLines,
  type TextEdit,
  type TextSelection,
} from "@/lib/markdown-editing";

interface FormatAction {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  run: (text: string, selection: TextSelection) => TextEdit;
}

const formatGroups: FormatAction[][] = [
  [
    {
      label: "Bold",
      icon: Bold,
      shortcut: "B",
      run: (text, selection) => toggleInline(text, selection, "bold"),
    },
    {
      label: "Italic",
      icon: Italic,
      shortcut: "I",
      run: (text, selection) => toggleInline(text, selection, "italic"),
    },
    {
      label: "Strikethrough",
      icon: Strikethrough,
      run: (text, selection) => toggleInline(text, selection, "strike"),
    },
    {
      label: "Code",
      icon: Code,
      shortcut: "E",
      run: (text, selection) => toggleInline(text, selection, "code"),
    },
    { label: "Link", icon: Link, shortcut: "K", run: insertLink },
  ],
  [
    {
      label: "Heading",
      icon: Heading2,
      run: (text, selection) => toggleLines(text, selection, "heading"),
    },
    {
      label: "Quote",
      icon: Quote,
      run: (text, selection) => toggleLines(text, selection, "quote"),
    },
    {
      label: "Bulleted list",
      icon: List,
      run: (text, selection) => toggleLines(text, selection, "bullet"),
    },
    {
      label: "Numbered list",
      icon: ListOrdered,
      run: (text, selection) => toggleLines(text, selection, "number"),
    },
    {
      label: "Checklist",
      icon: ListTodo,
      run: (text, selection) => toggleLines(text, selection, "task"),
    },
  ],
];
const shortcuts = new Map(
  formatGroups
    .flat()
    .filter((action) => action.shortcut)
    .map((action) => [action.shortcut!, action]),
);

function selectionOf(textarea: HTMLTextAreaElement): TextSelection {
  return { start: textarea.selectionStart, end: textarea.selectionEnd };
}

function applyEdit(textarea: HTMLTextAreaElement, edit: TextEdit) {
  textarea.focus();
  if (edit.from !== edit.to || edit.insert) {
    textarea.setSelectionRange(edit.from, edit.to);
    document.execCommand(
      edit.insert ? "insertText" : "delete",
      false,
      edit.insert,
    );
  }
  textarea.setSelectionRange(edit.selection.start, edit.selection.end);
}

export function MarkdownTextarea({
  ref,
  className,
  onKeyDown,
  onPaste,
  ...props
}: React.ComponentProps<"textarea">) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const setInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      input.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  return (
    <div className={`cloud-markdown-input ${className ?? ""}`}>
      <div
        role="toolbar"
        aria-label="Formatting"
        className="cloud-markdown-toolbar"
      >
        {formatGroups.map((group, index) => (
          <div key={index} role="group">
            {group.map(({ label, icon: Icon, shortcut, run }) => (
              <button
                key={label}
                type="button"
                tabIndex={-1}
                aria-label={label}
                title={label}
                aria-keyshortcuts={
                  shortcut ? `Control+${shortcut} Meta+${shortcut}` : undefined
                }
                disabled={props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const textarea = input.current;
                  if (textarea)
                    applyEdit(
                      textarea,
                      run(textarea.value, selectionOf(textarea)),
                    );
                }}
              >
                <Icon size={15} aria-hidden="true" />
              </button>
            ))}
          </div>
        ))}
      </div>
      <textarea
        ref={setInput}
        {...props}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.nativeEvent.isComposing) return;
          const textarea = event.currentTarget;
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey
          ) {
            const action = shortcuts.get(event.key.toUpperCase());
            if (!action) return;
            event.preventDefault();
            applyEdit(
              textarea,
              action.run(textarea.value, selectionOf(textarea)),
            );
            return;
          }
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          const edit = continueList(textarea.value, selectionOf(textarea));
          if (!edit) return;
          event.preventDefault();
          applyEdit(textarea, edit);
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          const textarea = event.currentTarget;
          const edit = pasteLink(
            textarea.value,
            selectionOf(textarea),
            event.clipboardData.getData("text/plain"),
          );
          if (!edit) return;
          event.preventDefault();
          applyEdit(textarea, edit);
        }}
      />
    </div>
  );
}
