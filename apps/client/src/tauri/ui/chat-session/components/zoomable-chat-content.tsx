import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import {
  accumulateChatZoomWheel,
  getZoomAnchoredScrollTop,
  stepChatZoomPercent,
} from "../_helpers/chat-zoom";

export interface ZoomableChatContentProps {
  zoomPercent: number;
  onZoomPercentChange: (zoomPercent: number) => void;
  children: ReactNode;
}

const findScrollViewport = (element: HTMLElement): HTMLElement | null =>
  element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');

export const ZoomableChatContent = ({
  zoomPercent,
  onZoomPercentChange,
  children,
}: ZoomableChatContentProps): JSX.Element => {
  const contentRef = useRef<HTMLDivElement>(null);
  const appliedZoomPercentRef = useRef<number | null>(null);
  const requestedZoomPercentRef = useRef(zoomPercent);
  const anchorOffsetRef = useRef(0);
  const onZoomPercentChangeRef = useRef(onZoomPercentChange);
  requestedZoomPercentRef.current = zoomPercent;
  onZoomPercentChangeRef.current = onZoomPercentChange;

  useLayoutEffect(() => {
    const content = contentRef.current;

    if (!content || appliedZoomPercentRef.current === zoomPercent) {
      return;
    }

    const viewport = findScrollViewport(content);
    const previousMetrics =
      viewport && appliedZoomPercentRef.current !== null
        ? {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          }
        : null;

    content.style.zoom = String(zoomPercent / 100);
    appliedZoomPercentRef.current = zoomPercent;

    if (viewport && previousMetrics) {
      viewport.scrollTop = getZoomAnchoredScrollTop(
        previousMetrics,
        viewport.scrollHeight,
        anchorOffsetRef.current,
      );
    }

    anchorOffsetRef.current = 0;
  }, [zoomPercent]);

  useEffect(() => {
    const content = contentRef.current;
    const viewport = content ? findScrollViewport(content) : null;

    if (!viewport) {
      return;
    }

    let wheelDistance = 0;
    const zoomOnControlWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const wheel = accumulateChatZoomWheel(wheelDistance, event);
      wheelDistance = wheel.distance;

      if (wheel.direction === null) {
        return;
      }

      const nextZoomPercent = stepChatZoomPercent(
        requestedZoomPercentRef.current,
        wheel.direction,
      );

      if (nextZoomPercent === requestedZoomPercentRef.current) {
        return;
      }

      anchorOffsetRef.current =
        event.clientY - viewport.getBoundingClientRect().top;
      requestedZoomPercentRef.current = nextZoomPercent;
      onZoomPercentChangeRef.current(nextZoomPercent);
    };

    viewport.addEventListener("wheel", zoomOnControlWheel, { passive: false });

    return () => {
      viewport.removeEventListener("wheel", zoomOnControlWheel);
    };
  }, []);

  return <div ref={contentRef}>{children}</div>;
};
