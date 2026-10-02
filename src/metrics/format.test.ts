import { describe, expect, it } from 'vitest'
import { fmtClock, fmtUsd } from './format.ts'

describe('fmtClock', () => {
  it('carries rounded seconds into the next minute', () => {
    expect(fmtClock(119_960)).toBe('2:00.0')
    expect(fmtClock(59_960)).toBe('1:00.0')
  })

  it('formats regular values', () => {
    expect(fmtClock(0)).toBe('0:00.0')
    expect(fmtClock(65_900)).toBe('1:05.9')
    expect(fmtClock(-5)).toBe('0:00.0')
  })
})

describe('fmtUsd', () => {
  it('keeps sub-cent amounts readable', () => {
    expect(fmtUsd(0.00004)).toBe('$0.000040')
    expect(fmtUsd(0.0059)).toBe('$0.0059')
    expect(fmtUsd(0.023)).toBe('$0.023')
    expect(fmtUsd(0)).toBe('$0.00')
  })
})
