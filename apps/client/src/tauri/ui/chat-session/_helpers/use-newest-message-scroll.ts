import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

const SCROLL_TO_NEWEST_THRESHOLD_PX = 8;

const getScrollDistanceToBottom = (
  scrollViewport: HTMLElement,
  scrollHeight = scrollViewport.scrollHeight,
  clientHeight = scrollViewport.clientHeight,
): number => {
  return scrollHeight - scrollViewport.scrollTop - clientHeight;
};

const isScrollViewportNearBottom = (
  scrollViewport: HTMLElement,
  scrollHeight = scrollViewport.scrollHeight,
  clientHeight = scrollViewport.clientHeight,
): boolean => {
  return (
    getScrollDistanceToBottom(scrollViewport, scrollHeight, clientHeight) <=
    SCROLL_TO_NEWEST_THRESHOLD_PX
  );
};

interface ScrollViewportMetrics {
  scrollHeight: number;
  clientHeight: number;
}

const getScrollViewportMetrics = (
  scrollViewport: HTMLElement,
): ScrollViewportMetrics => ({
  scrollHeight: scrollViewport.scrollHeight,
  clientHeight: scrollViewport.clientHeight,
});

const scrollViewportToBottom = (scrollViewport: HTMLElement): void => {
  scrollViewport.scrollTop = Math.max(
    0,
    scrollViewport.scrollHeight - scrollViewport.clientHeight,
  );
};

const findScrollViewport = (bottomElement: HTMLElement): HTMLElement | null => {
  return bottomElement.closest<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
};

export interface NewestMessageScrollController {
  bottomRef: RefObject<HTMLDivElement | null>;
  showScrollToNewestButton: boolean;
  scrollToNewest: () => void;
}

export interface UseNewestMessageScrollOptions {
  resetKey: string;
  contentKey: unknown;
}

export const useNewestMessageScroll = ({
  resetKey,
  contentKey,
}: UseNewestMessageScrollOptions): NewestMessageScrollController => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollToNewestButton, setShowScrollToNewestButton] =
    useState(false);
  const lastScrollMetricsRef = useRef<ScrollViewportMetrics | null>(null);
  const lastScrollResetKeyRef = useRef<string | null>(null);
  const isScrollPinnedToNewestRef = useRef(true);

  const scrollToNewest = useCallback((): void => {
    const bottomElement = bottomRef.current;

    if (!bottomElement) {
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      bottomElement.scrollIntoView({ block: "end" });
      isScrollPinnedToNewestRef.current = true;
      setShowScrollToNewestButton(false);
      return;
    }

    scrollViewportToBottom(scrollViewport);
    lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
    isScrollPinnedToNewestRef.current = true;
    setShowScrollToNewestButton(false);
  }, []);

  useLayoutEffect(() => {
    const bottomElement = bottomRef.current;

    if (!bottomElement) {
      isScrollPinnedToNewestRef.current = true;
      lastScrollResetKeyRef.current = resetKey;
      lastScrollMetricsRef.current = null;
      setShowScrollToNewestButton(false);
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      bottomElement.scrollIntoView({ block: "end" });
      isScrollPinnedToNewestRef.current = true;
      lastScrollResetKeyRef.current = resetKey;
      lastScrollMetricsRef.current = null;
      setShowScrollToNewestButton(false);
      return;
    }

    const previousScrollMetrics =
      lastScrollResetKeyRef.current === resetKey
        ? lastScrollMetricsRef.current
        : null;
    const wasNearBottom =
      previousScrollMetrics === null ||
      isScrollViewportNearBottom(
        scrollViewport,
        previousScrollMetrics.scrollHeight,
        previousScrollMetrics.clientHeight,
      );

    lastScrollResetKeyRef.current = resetKey;
    lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
    isScrollPinnedToNewestRef.current = wasNearBottom;
    setShowScrollToNewestButton(!wasNearBottom);

    if (wasNearBottom) {
      scrollViewportToBottom(scrollViewport);
      lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
      setShowScrollToNewestButton(false);
    }

    const updateScrollPinnedState = (): void => {
      const isPinnedToNewest = isScrollViewportNearBottom(scrollViewport);

      isScrollPinnedToNewestRef.current = isPinnedToNewest;
      lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
      setShowScrollToNewestButton(!isPinnedToNewest);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const previousScrollMetrics = lastScrollMetricsRef.current;
            const wasPinnedToNewest =
              isScrollPinnedToNewestRef.current &&
              (previousScrollMetrics === null ||
                isScrollViewportNearBottom(
                  scrollViewport,
                  previousScrollMetrics.scrollHeight,
                  previousScrollMetrics.clientHeight,
                ));

            if (wasPinnedToNewest) {
              scrollViewportToBottom(scrollViewport);
            }

            updateScrollPinnedState();
          });

    scrollViewport.addEventListener("scroll", updateScrollPinnedState, {
      passive: true,
    });
    resizeObserver?.observe(scrollViewport);
    resizeObserver?.observe(bottomElement.parentElement ?? bottomElement);

    return () => {
      scrollViewport.removeEventListener("scroll", updateScrollPinnedState);
      resizeObserver?.disconnect();
    };
  }, [resetKey]);

  useLayoutEffect(() => {
    const bottomElement = bottomRef.current;

    if (!bottomElement || lastScrollResetKeyRef.current !== resetKey) {
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      return;
    }

    if (isScrollPinnedToNewestRef.current) {
      scrollViewportToBottom(scrollViewport);
      setShowScrollToNewestButton(false);
    } else {
      setShowScrollToNewestButton(!isScrollViewportNearBottom(scrollViewport));
    }

    lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
  }, [contentKey, resetKey]);

  return {
    bottomRef,
    showScrollToNewestButton,
    scrollToNewest,
  };
};
