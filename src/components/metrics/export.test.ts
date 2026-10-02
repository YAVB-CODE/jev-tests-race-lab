import { describe, expect, it } from 'vitest'
import { buildRunCsv, buildRunJson, csvCell } from './export.ts'
import { generateSampleLanes } from '../../metrics/__fixtures__/sampleRecords.ts'

describe('csvCell', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('renders numbers, booleans and empties', () => {
    expect(csvCell(12.5)).toBe('12.5')
    expect(csvCell(Number.NaN)).toBe('')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('neutralizes spreadsheet formulas in text', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell(-3)).toBe('-3') // numbers are untouched
  })
})

describe('buildRunCsv', () => {
  const lanes = generateSampleLanes({ count: 25, seed: 9 })
  const csv = buildRunCsv(lanes)
  const lines = csv.trimEnd().split('\r\n')

  it('has a header and one row per decision of both lanes', () => {
    expect(lines).toHaveLength(1 + 25 + 25)
    expect(lines[0].startsWith('lane,mode,model,decision,')).toBe(true)
    expect(lines[1].startsWith('gpt,mock,')).toBe(true)
    expect(lines[26].startsWith('jev,mock,')).toBe(true)
  })

  it('keeps every row aligned with the header', () => {
    const width = lines[0].split(',').length
    // rows with quoted commas would break a naive split; the fixtures only use plain messages
    for (const line of lines.slice(1)) expect(line.split(',').length).toBe(width)
  })
})

describe('buildRunJson', () => {
  const lanes = generateSampleLanes({ count: 20, seed: 9 })
  const parsed = JSON.parse(buildRunJson(lanes, { track: 'oval', seed: 9 }, new Date('2026-01-02T03:04:05Z')))

  it('includes metadata, computed metrics, comparison and records', () => {
    expect(parsed.exportedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(parsed.meta).toEqual({ track: 'oval', seed: 9 })
    expect(parsed.lanes.gpt.records).toHaveLength(20)
    expect(parsed.lanes.jev.metrics.decisions).toBe(20)
    expect(parsed.lanes.jev.snapshot.engine).toBe('jev')
    expect(Array.isArray(parsed.comparison)).toBe(true)
    expect(parsed.comparison.length).toBeGreaterThan(10)
  })

  it('flags simulated runs as not valid for efficacy', () => {
    expect(parsed.validForEfficacy).toBe(false)
    const live = generateSampleLanes({ count: 5, modes: { gpt: 'live', jev: 'live' } })
    expect(JSON.parse(buildRunJson(live)).validForEfficacy).toBe(true)
  })
})
