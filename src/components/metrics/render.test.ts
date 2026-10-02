// Smoke tests: every component renders to static markup (empty lanes, full lanes, both modes) without throwing.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EngineId, LaneData } from '../../shared/contracts.ts'
import { generateSampleLanes } from '../../metrics/__fixtures__/sampleRecords.ts'
import { ChartsPanel, ComparisonPanel, DecisionLog, LaneMetrics, MetricsDemo, SIMULATED_DISCLAIMER } from './index.ts'

const full = generateSampleLanes({ count: 30, seed: 3 })
const live = generateSampleLanes({ count: 30, seed: 3, modes: { gpt: 'live', jev: 'live' } })
const empty: Record<EngineId, LaneData> = {
  gpt: { engine: 'gpt', label: 'GPT', mode: 'mock', records: [], snapshot: null },
  jev: { engine: 'jev', label: 'Jev', mode: 'live', records: [], snapshot: null },
}

describe('metrics components render', () => {
  it('LaneMetrics: tiles, tooltips and the mode badge', () => {
    const html = renderToStaticMarkup(createElement(LaneMetrics, { lane: full.gpt }))
    expect(html).toContain('SIMULADO')
    expect(html).toContain('Aciertos')
    expect(html).toContain('title="')
    expect(renderToStaticMarkup(createElement(LaneMetrics, { lane: live.jev }))).toContain('LIVE')
    expect(html).not.toMatch(/NaN|Infinity|undefined/)
  })

  it('LaneMetrics: empty lane shows dashes, not NaN', () => {
    const html = renderToStaticMarkup(createElement(LaneMetrics, { lane: empty.gpt }))
    expect(html).toContain('—')
    expect(html).not.toMatch(/NaN|Infinity|undefined/)
  })

  it('ComparisonPanel: disclaimer only when a lane is simulated', () => {
    expect(renderToStaticMarkup(createElement(ComparisonPanel, { lanes: full }))).toContain(SIMULATED_DISCLAIMER)
    expect(renderToStaticMarkup(createElement(ComparisonPanel, { lanes: { gpt: full.gpt, jev: live.jev } }))).toContain(SIMULATED_DISCLAIMER)
    const liveHtml = renderToStaticMarkup(createElement(ComparisonPanel, { lanes: live }))
    expect(liveHtml).not.toContain(SIMULATED_DISCLAIMER)
    expect(liveHtml).toMatch(/decide \d+\.\d× más rápido con/)
    expect(renderToStaticMarkup(createElement(ComparisonPanel, { lanes: empty }))).not.toMatch(/NaN|Infinity|undefined/)
  })

  it('ChartsPanel and DecisionLog render with data and empty', () => {
    for (const lanes of [full, empty]) {
      const charts = renderToStaticMarkup(createElement(ChartsPanel, { lanes }))
      expect(charts).toContain('Latencia por decisión')
      expect(charts).toContain('Diagrama de confiabilidad')
      expect(charts).not.toMatch(/NaN|Infinity/)
      const log = renderToStaticMarkup(createElement(DecisionLog, { lanes }))
      expect(log).toContain('Registro de decisiones')
    }
    expect(renderToStaticMarkup(createElement(DecisionLog, { lanes: full }))).toContain('Acierto')
  })

  it('DecisionLog renders at most 300 rows, newest first', () => {
    const big = generateSampleLanes({ count: 400, seed: 2 })
    const html = renderToStaticMarkup(createElement(DecisionLog, { lanes: big }))
    const rows = html.match(/aria-label="Ver detalle/g) ?? []
    expect(rows).toHaveLength(300)
    // the newest decision of either lane (#400) comes before any older one
    const first = /decisión (\d+) de/.exec(html)
    expect(first?.[1]).toBe('400')
  })

  it('MetricsDemo renders', () => {
    expect(renderToStaticMarkup(createElement(MetricsDemo))).toContain('Registro de decisiones')
  })
})
