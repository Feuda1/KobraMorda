import { useEffect, useState } from "react";

/**
 * Caps how many items a grid/list renders at once, revealed a page at a
 * time via a "show more" button, so a card stays usable once there are
 * dozens of models/files/timelapses instead of growing without limit.
 * Resets back to the first page whenever the underlying list identity
 * changes (e.g. a fresh fetch after switching printers).
 */
export function useShowMore(total: number, page: number) {
  const [shown, setShown] = useState(page);
  useEffect(() => {
    setShown(page);
  }, [page]);
  const hasMore = total > shown;
  const showMore = () => setShown((n) => n + page);
  return { shown: Math.min(shown, total), hasMore, showMore };
}
