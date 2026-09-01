export interface TimelineWindowItem<T> {
  item: T
  index: number
}

/**
 * Keeps a compact, stable history-rail window around the active date. Near
 * either edge, the window is shifted so it still contains the same number of
 * dates whenever enough dates exist.
 */
export function getTimelineHistoryWindow<T>(
  items: readonly T[],
  activeIndex: number,
  neighborCount = 5
): TimelineWindowItem<T>[] {
  if (!items.length) return []
  const safeNeighborCount = Math.max(0, Math.floor(neighborCount))
  const windowSize = Math.min(items.length, safeNeighborCount * 2 + 1)
  const clampedActiveIndex = Math.min(items.length - 1, Math.max(0, activeIndex))
  const maxStart = items.length - windowSize
  const start = Math.min(maxStart, Math.max(0, clampedActiveIndex - safeNeighborCount))

  return items.slice(start, start + windowSize).map((item, offset) => ({
    item,
    index: start + offset
  }))
}
