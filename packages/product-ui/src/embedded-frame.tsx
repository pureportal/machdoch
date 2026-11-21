"use client";

import { useEffect, useRef } from "react";
import type { IframeHTMLAttributes, RefObject } from "react";
import { viewVisibilityMessage } from "./view-visibility";

function postVisibility(frame: HTMLIFrameElement | null, visible: boolean): void {
  frame?.contentWindow?.postMessage(
    { type: viewVisibilityMessage, visible },
    window.location.origin,
  );
}

export function EmbeddedFrame({
  visible,
  frameRef,
  onLoad,
  title,
  ...frame
}: {
  visible: boolean;
  title: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
} & Omit<
  IframeHTMLAttributes<HTMLIFrameElement>,
  "className" | "hidden" | "style" | "title"
>): React.ReactElement {
  const ownRef = useRef<HTMLIFrameElement>(null);
  const ref = frameRef ?? ownRef;
  useEffect(() => {
    postVisibility(ref.current, visible);
  }, [ref, visible]);
  return (
    <main
      className="m-product-feature-main"
      hidden={!visible}
      style={visible ? undefined : { display: "none" }}
    >
      <iframe
        {...frame}
        ref={ref}
        title={title}
        className="m-product-media-frame"
        onLoad={(event) => {
          postVisibility(event.currentTarget, visible);
          onLoad?.(event);
        }}
      />
    </main>
  );
}
