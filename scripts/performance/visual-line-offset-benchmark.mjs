import { performance } from 'node:perf_hooks'

const nodeCount = Number(process.env.FOLIO_BENCHMARK_NODES || 128)
const tokenCount = Number(process.env.FOLIO_BENCHMARK_TOKENS || 2_048)
const samples = Number(process.env.FOLIO_BENCHMARK_SAMPLES || 9)

const segments = []
let offset = 0
for (let index = 0; index < nodeCount; index += 1) {
  const length = 20 + (index % 13)
  segments.push({ start: offset, end: offset + length })
  offset += length
}
const totalLength = offset
const tokens = Array.from({ length: tokenCount }, (_, index) => {
  const start = Math.floor((index * totalLength) / tokenCount)
  return { start, end: Math.min(totalLength, start + 8) }
})

function treeWalkResolution(start, end) {
  let startSegment = null
  let endSegment = null
  for (const segment of segments) {
    if (!startSegment && segment.end >= start) startSegment = segment
    if (segment.end >= end) {
      endSegment = segment
      break
    }
  }
  return startSegment && endSegment
}

function indexedResolution(start, end) {
  function resolve(value) {
    let low = 0
    let high = segments.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (segments[middle].start <= value) low = middle + 1
      else high = middle
    }
    const candidate = segments[low - 1]
    return candidate && value <= candidate.end ? candidate : null
  }
  return resolve(start) && resolve(end)
}

function measure(resolver) {
  const startedAt = performance.now()
  let resolved = 0
  for (const token of tokens) if (resolver(token.start, token.end)) resolved += 1
  return { elapsedMs: performance.now() - startedAt, resolved }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

for (let index = 0; index < 2; index += 1) {
  measure(treeWalkResolution)
  measure(indexedResolution)
}
const baseline = []
const indexed = []
for (let index = 0; index < samples; index += 1) {
  baseline.push(measure(treeWalkResolution))
  indexed.push(measure(indexedResolution))
}

const baselineMs = median(baseline.map((sample) => sample.elapsedMs))
const indexedMs = median(indexed.map((sample) => sample.elapsedMs))
console.log(JSON.stringify({
  nodeCount,
  tokenCount,
  samples,
  baselineMedianMs: baselineMs,
  indexedMedianMs: indexedMs,
  speedup: baselineMs / Math.max(indexedMs, Number.EPSILON),
  resolved: indexed.at(-1)?.resolved || 0,
}, null, 2))
