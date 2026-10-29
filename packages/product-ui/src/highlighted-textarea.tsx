import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { tokenizeComposer } from "./composer-syntax";
import "./highlighted-textarea.css";

const textProperties = [
  "font",
  "font-kerning",
  "font-feature-settings",
  "letter-spacing",
  "line-height",
  "text-align",
  "text-indent",
  "text-transform",
  "tab-size",
  "word-spacing",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "direction",
  "overflow-wrap",
  "word-break",
] as const;

export function HighlightedTextarea({
  ref,
  onChange,
  onScroll,
  ...props
}: ComponentProps<"textarea">) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState(
    String(props.defaultValue ?? ""),
  );
  const value = String(props.value ?? uncontrolledValue);
  const tokens = useMemo(() => tokenizeComposer(value), [value]);
  const highlighted = tokens.some((token) => token.kind) && !props.disabled;
  const sync = useCallback(() => {
    const input = inputRef.current;
    const overlay = overlayRef.current;
    if (!input || !overlay) return;
    const style = getComputedStyle(input);
    for (const property of textProperties)
      overlay.style.setProperty(property, style.getPropertyValue(property));
    overlay.style.width = `${input.clientWidth + parseFloat(style.borderLeftWidth || "0") + parseFloat(style.borderRightWidth || "0")}px`;
    overlay.style.height = `${input.offsetHeight}px`;
    overlay.style.clipPath = `inset(${style.paddingTop} ${style.borderRightWidth} ${style.paddingBottom} ${style.borderLeftWidth} round ${style.borderRadius})`;
    overlay.scrollTop = input.scrollTop;
    overlay.scrollLeft = input.scrollLeft;
  }, []);
  useLayoutEffect(sync);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    return () => observer.disconnect();
  }, [sync]);
  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return (
    <div className="m-composer-editor" data-highlighted={highlighted}>
      <textarea
        {...props}
        ref={setRef}
        onChange={(event) => {
          setUncontrolledValue(event.target.value);
          onChange?.(event);
        }}
        onScroll={(event) => {
          sync();
          onScroll?.(event);
        }}
      />
      <div ref={overlayRef} className="m-composer-highlight" aria-hidden="true">
        {tokens.map((token, index) =>
          token.kind ? (
            <span key={index} data-syntax={token.kind}>
              {token.text}
            </span>
          ) : (
            token.text
          ),
        )}
        {"\n"}
      </div>
    </div>
  );
}
