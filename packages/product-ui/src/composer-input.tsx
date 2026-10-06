import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type Ref,
} from "react";
import "./composer-surface.css";

export interface ComposerInputProps extends Omit<
  ComponentProps<"textarea">,
  "onSubmit"
> {
  onSubmit: () => void;
  ref?: Ref<HTMLTextAreaElement>;
}

export function ComposerInput({
  onSubmit,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  className,
  ref,
  rows = 1,
  ...props
}: ComposerInputProps): React.ReactElement {
  const nodeRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const resize = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, []);
  const setNode = useCallback(
    (node: HTMLTextAreaElement | null) => {
      nodeRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  useLayoutEffect(resize, [props.value, resize]);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (node.clientWidth === width) return;
            width = node.clientWidth;
            resize();
          });
    observer?.observe(node);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [resize]);
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      window.matchMedia?.("(pointer: coarse)").matches
    )
      return;
    event.preventDefault();
    if (!props.disabled) onSubmit();
  };
  return (
    <textarea
      {...props}
      ref={setNode}
      rows={rows}
      className={["m-composer-input", className].filter(Boolean).join(" ")}
      onKeyDown={handleKeyDown}
      onCompositionStart={(event) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onCompositionEnd?.(event);
      }}
    />
  );
}
