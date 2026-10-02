/** Deterministic, seedable randomness shared by the simulator (hazards) and the mock engines. */

/** mulberry32 — returns a generator of floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Derive a stable sub-seed, e.g. hashSeed(seed, 'hazards', lap). FNV-1a over the stringified parts. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Integer in [min, max] inclusive. */
export function randInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}

/** Standard normal via Box–Muller. */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Log-normal sample with the given median and log-space sigma (handy for latency simulation). */
export function logNormal(rand: () => number, median: number, sigma: number): number {
  return median * Math.exp(sigma * gaussian(rand))
}
