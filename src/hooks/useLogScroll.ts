import { useRef, useEffect, useCallback } from "react";

interface UseLogScrollOptions {
  logs: string[];
  followTail: boolean;
}

export function useLogScroll({ logs, followTail }: UseLogScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const isFirstScroll = useRef(true);

  // Auto-scroll when new logs arrive and followTail is enabled
  useEffect(() => {
    if (!followTail) return;
    if (isFirstScroll.current) {
      isFirstScroll.current = false;
      logEndRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, followTail]);

  const scrollToBottom = useCallback(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Reset first-scroll flag so callers can trigger it when switching contexts
  const resetFirstScroll = useCallback(() => {
    isFirstScroll.current = true;
  }, []);

  return { containerRef, logEndRef, scrollToBottom, resetFirstScroll };
}
