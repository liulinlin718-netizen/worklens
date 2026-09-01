import { describe, expect, it } from 'vitest'
import { getTimelineHistoryWindow } from '../../src/renderer/src/timeline-window'

describe('getTimelineHistoryWindow', () => {
  const dates = Array.from({ length: 48 }, (_, index) => `date-${index}`)

  it('keeps the active date centered in a compact window', () => {
    const window = getTimelineHistoryWindow(dates, 24)

    expect(window).toHaveLength(11)
    expect(window.map(({ index }) => index)).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
    expect(window[5]).toEqual({ item: 'date-24', index: 24 })
  })

  it('fills the window from the available dates at both ends', () => {
    expect(getTimelineHistoryWindow(dates, 0).map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(getTimelineHistoryWindow(dates, 47).map(({ index }) => index)).toEqual([37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47])
  })
})
