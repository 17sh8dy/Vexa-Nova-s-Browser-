'use strict';
// PageRank by power iteration over the crawled link graph.
// Dangling pages (no outlinks) spread their rank evenly, as in the paper.
// Returned scores are scaled so the average page scores 1.

function pagerank(nodeIds, edges, { damping = 0.85, iterations = 40, tolerance = 1e-9 } = {}) {
  const n = nodeIds.length;
  const result = new Map();
  if (!n) return result;
  const index = new Map(nodeIds.map((id, i) => [id, i]));
  const out = Array.from({ length: n }, () => new Set());
  for (const [from, to] of edges) {
    const a = index.get(from);
    const b = index.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    out[a].add(b);
  }
  const outDeg = out.map((s) => s.size);
  const outList = out.map((s) => [...s]);

  let rank = new Float64Array(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) { dangling += rank[i]; continue; }
      const share = rank[i] / outDeg[i];
      for (const j of outList[i]) next[j] += share;
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    let diff = 0;
    for (let i = 0; i < n; i++) {
      next[i] = base + damping * next[i];
      diff += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (diff < tolerance) break;
  }
  for (let i = 0; i < n; i++) result.set(nodeIds[i], rank[i] * n);
  return result;
}

module.exports = { pagerank };
