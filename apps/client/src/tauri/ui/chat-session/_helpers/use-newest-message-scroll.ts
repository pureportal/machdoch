import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefCallback,
} from "react";

const SCROLL_EDGE_THRESHOLD_PX = 8;

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
    SCROLL_EDGE_THRESHOLD_PX
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
  bottomRef: RefCallback<HTMLDivElement>;
  showScrollToTopButton: boolean;
  scrollToTop: () => void;
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
  const [bottomElement, setBottomElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [showScrollToNewestButton, setShowScrollToNewestButton] =
    useState(false);
  const [showScrollToTopButton, setShowScrollToTopButton] = useState(false);
  const lastScrollMetricsRef = useRef<ScrollViewportMetrics | null>(null);
  const isScrollPinnedToNewestRef = useRef(true);

  const scrollToTop = useCallback((): void => {
    if (!bottomElement) {
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      return;
    }

    scrollViewport.scrollTop = 0;
    const isPinnedToNewest = isScrollViewportNearBottom(scrollViewport);
    lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
    isScrollPinnedToNewestRef.current = isPinnedToNewest;
    setShowScrollToNewestButton(!isPinnedToNewest);
    setShowScrollToTopButton(false);
  }, [bottomElement]);

  const scrollToNewest = useCallback((): void => {
    if (!bottomElement) {
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      return;
    }

    scrollViewportToBottom(scrollViewport);
    lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
    isScrollPinnedToNewestRef.current = true;
    setShowScrollToNewestButton(false);
    setShowScrollToTopButton(
      scrollViewport.scrollTop > SCROLL_EDGE_THRESHOLD_PX,
    );
  }, [bottomElement]);

  useLayoutEffect(() => {
    isScrollPinnedToNewestRef.current = true;
    lastScrollMetricsRef.current = null;
    setShowScrollToNewestButton(false);
    setShowScrollToTopButton(false);

    if (!bottomElement) {
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      return;
    }

    scrollViewportToBottom(scrollViewport);
    lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
    setShowScrollToTopButton(
      scrollViewport.scrollTop > SCROLL_EDGE_THRESHOLD_PX,
    );

    const updateScrollPinnedState = (): void => {
      const isPinnedToNewest = isScrollViewportNearBottom(scrollViewport);

      isScrollPinnedToNewestRef.current = isPinnedToNewest;
      lastScrollMetricsRef.current = getScrollViewportMetrics(scrollViewport);
      setShowScrollToNewestButton(!isPinnedToNewest);
      setShowScrollToTopButton(
        scrollViewport.scrollTop > SCROLL_EDGE_THRESHOLD_PX,
      );
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
  }, [bottomElement, resetKey]);

  useLayoutEffect(() => {
    if (!bottomElement) {
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
    setShowScrollToTopButton(
      scrollViewport.scrollTop > SCROLL_EDGE_THRESHOLD_PX,
    );
  }, [bottomElement, contentKey, resetKey]);

  return {
    bottomRef: setBottomElement,
    showScrollToTopButton,
    scrollToTop,
    showScrollToNewestButton,
    scrollToNewest,
  };
};
