import type { TrackSpec } from './parse.ts'

/** Warm-up: a plain loop, no forks. */
export const OVALO: TrackSpec = {
  id: 'ovalo',
  name: 'Óvalo',
  description: 'Circuito simple sin bifurcaciones para calentar: dos rectas largas, dos cortas y cuatro curvas.',
  startHeading: 'E',
  map: `
    ..................
    .┌──S───────────┐.
    .│..............│.
    .│..............│.
    .│..............1.
    .3..............│.
    .│..............│.
    .│..............│.
    .└───────2──────┘.
    ..................
  `,
}

/** Curves, chicanes and straights of every length: exercises the speed rule. */
export const TECNICO: TrackSpec = {
  id: 'tecnico',
  name: 'Técnico',
  description: 'Curvas, chicanes, una escalera y rectas de distinta longitud que ponen a prueba la regla de velocidad.',
  startHeading: 'E',
  map: `
    ....................
    ..┌─S───┐..┌─────┐..
    ..│.....│..│.....│..
    ..│.....└──┘.....1..
    ..│...........┌──┘..
    ..│...........│.....
    ..3...........└──┐..
    ..│..............│..
    ..│......┌──┐....│..
    ..└┐.....│..│....│..
    ...└┐....│..│....│..
    ....└────┘..└─2──┘..
    ....................
  `,
}

/**
 * Three forks whose branches rejoin (shortcut vs. long branch). A checkpoint sits after every merge,
 * so "shortest route to the next checkpoint" is the truly optimal racing line at each fork.
 * Fork A (top): forward = shortcut, left = detour. Fork B (right): forward = shortcut, right = detour.
 * Fork C (bottom): no forward exit; right branch is shorter than the left one.
 */
export const BIFURCACIONES: TrackSpec = {
  id: 'bifurcaciones',
  name: 'Bifurcaciones',
  description: 'Tres bifurcaciones que se vuelven a unir (atajo contra rama larga); en cada vuelta los conos pueden cerrar una rama.',
  startHeading: 'E',
  map: `
    .....................
    ......┌───┐..........
    ......│...│..........
    .┌─S──┴───┴─1──────┐.
    .│.................│.
    .│.................│.
    .│...............┌─┤.
    .│...............│.│.
    .│...............│.│.
    .│...............│.│.
    .│...............└─┤.
    .│.......┌────┐....│.
    .└────3──┤....├──2─┘.
    .........│....│......
    .........└────┘......
    .....................
  `,
}

export const TRACK_SPECS: readonly TrackSpec[] = [OVALO, TECNICO, BIFURCACIONES]
