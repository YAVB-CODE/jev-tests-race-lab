import type { TrackDefinition } from '../../shared/contracts.ts'
import { parseTrack } from './parse.ts'
import { TRACK_SPECS } from './presets.ts'

export { parseTrack } from './parse.ts'
export type { TrackSpec } from './parse.ts'

/** Preset circuits, parsed and validated at load time (an invalid preset throws on import). */
export const TRACKS: TrackDefinition[] = TRACK_SPECS.map(parseTrack)

/** Preset by id; throws when unknown. */
export function getTrack(id: string): TrackDefinition {
  const track = TRACKS.find((t) => t.id === id)
  if (!track) throw new Error(`Unknown track "${id}". Available: ${TRACKS.map((t) => t.id).join(', ')}`)
  return track
}
