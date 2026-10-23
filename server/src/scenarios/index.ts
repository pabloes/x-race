/**
 * Every circuit brings its own physics scenarios, keyed like `TRACKS`, so a circuit cannot
 * be added without saying how its set pieces are tested.
 */

import type { Track, TrackId } from '../../../shared/tracks'
import { cityScenarios } from './city'
import type { Scenario } from './common'
import { skylineScenarios } from './skyline'

export type { Scenario } from './common'

export const SCENARIOS: Record<TrackId, (track: Track) => Scenario[]> = {
  city: cityScenarios,
  skyline: skylineScenarios
}
