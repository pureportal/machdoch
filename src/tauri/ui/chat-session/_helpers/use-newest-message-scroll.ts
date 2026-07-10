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
): number => {
  return scrollHeight - scrollViewport.scrollTop - scrollViewport.clientHeight;
};

const isScrollViewportNearBottom = (
  scrollViewport: HTMLElement,
  scrollHeight = scrollViewport.scrollHeight,
): boolean => {
  return getScrollDistanceToBottom(scrollViewport, scrollHeight) <=
    SCROLL_TO_NEWEST_THRESHOLD_PX;
};

const scrollViewportToBottom = (scrollViewport: HTMLElement): void => {
  scrollViewport.scrollTop = Math.max(
    0,
    scrollViewport.scrollHeight - scrollViewport.clientHeight,
  );
};

const findScrollViewport = (
  bottomElement: HTMLElement,
): HTMLElement | null => {
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
  const lastScrollHeightRef = useRef<number | null>(null);
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
    lastScrollHeightRef.current = scrollViewport.scrollHeight;
    isScrollPinnedToNewestRef.current = true;
    setShowScrollToNewestButton(false);
  }, []);

  useLayoutEffect(() => {
    const bottomElement = bottomRef.current;

    if (!bottomElement) {
      isScrollPinnedToNewestRef.current = true;
      lastScrollResetKeyRef.current = resetKey;
      lastScrollHeightRef.current = null;
      setShowScrollToNewestButton(false);
      return;
    }

    const scrollViewport = findScrollViewport(bottomElement);

    if (!scrollViewport) {
      bottomElement.scrollIntoView({ block: "end" });
      isScrollPinnedToNewestRef.current = true;
      lastScrollResetKeyRef.current = resetKey;
      lastScrollHeightRef.current = null;
      setShowScrollToNewestButton(false);
      return;
    }

    const previousScrollHeight =
      lastScrollResetKeyRef.current === resetKey
        ? lastScrollHeightRef.current
        : null;
    const wasNearBottom =
      previousScrollHeight === null ||
      isScrollViewportNearBottom(scrollViewport, previousScrollHeight);

    lastScrollResetKeyRef.current = resetKey;
    lastScrollHeightRef.current = scrollViewport.scrollHeight;
    isScrollPinnedToNewestRef.current = wasNearBottom;
    setShowScrollToNewestButton(!wasNearBottom);

    if (wasNearBottom) {
      scrollViewportToBottom(scrollViewport);
      lastScrollHeightRef.current = scrollViewport.scrollHeight;
      setShowScrollToNewestButton(false);
    }

    const updateScrollPinnedState = (): void => {
      const isPinnedToNewest = isScrollViewportNearBottom(scrollViewport);

      isScrollPinnedToNewestRef.current = isPinnedToNewest;
      lastScrollHeightRef.current = scrollViewport.scrollHeight;
      setShowScrollToNewestButton(!isPinnedToNewest);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (isScrollPinnedToNewestRef.current) {
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
      setShowScrollToNewestButton(
        !isScrollViewportNearBottom(scrollViewport),
      );
    }

    lastScrollHeightRef.current = scrollViewport.scrollHeight;
  }, [contentKey, resetKey]);

  return {
    bottomRef,
    showScrollToNewestButton,
    scrollToNewest,
  };
};
