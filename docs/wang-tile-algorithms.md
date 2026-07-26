# Wang Tile Generation Algorithms

> Research notes on algorithms to generate Wang tiles from seamless source textures.
> The current implementation lives in `tools/wang-tiles/generate.mjs`.

## Overview

A Wang tile set has 16 tiles, one for each 4-bit corner-colour permutation (TL,TR,BR,BL ∈ {0,1}). Adjacent tiles in a grid share corner colours — if tile(i,j) has TR=1 and tile(i+1,j) has TL=1, their touching edge should be seamless.

The question is: **given a single seamless input texture, how do we produce 16 tiles that satisfy this edge-matching constraint?**

---

## Algorithm 1: Diagonal Quadrant Swap (Current)

The simplest approach, already implemented in `generate.mjs`.

**Method:**
1. Split source into 4 quadrants at the centre (TL₀, TR₀, BL₀, BR₀).
2. Derive colour-1 quadrants by diagonal swap: TL₁=BR₀, TR₁=BL₀, BL₁=TR₀, BR₁=TL₀.
3. For each corner permutation, assemble a 2×2 grid of the appropriate quadrant variants.

**Edge compatibility:**
- ✅ **Colour-0 seams** match because they use the source's left/right edges, which are identical due to source seamlessness
- ❌ **Colour-1 seams** mismatch because they pair the image centre (x ≈ W/2) with the image edge (x ≈ W-1), which the seamless-wrap property doesn't connect

**Verdict:** Fast, simple, but colour-1 seams are visibly broken for non-uniform textures.

---

## Algorithm 2: Cohen et al. (2003) — Search-Based Edge/Interior Filling

The canonical approach from "Wang Tiles for Image and Texture Generation" (SIGGRAPH 2003).

**Method:**
1. **Phase A — Edge strip selection (stratified search):** For each of the 4 edges × 4 colour pairs = 16 strips, search the source for the best 1-pixel-wide strip of length `tileSize`. Score by variance. **Critical fix**: each colour-pair variant searches a different region of the source (the source is divided into 4 equal bands per edge). Without this, all 4 variants converge to the same offset and tiles become identical.
2. **Phase B — Corner consistency:** For each corner (TL,TR,BR,BL) and colour (0,1), average the endpoint pixels of all strips meeting at that corner and propagate back. This guarantees the 1px edge seams match perfectly despite the stratified search.
3. **Phase C — Edge band extraction:** Sample BLEND-px-wide bands inward from each strip. Used for feathering.
4. **Phase D — Interior search:** For each of the 16 corner permutations, search the source for the best `(tileSize-2×BLEND-2)²` interior patch. Score by mean-squared-error (MSE) between the interior's border pixels and the 4 edge bands.
5. **Phase E — Assembly:** Place edge strips (1px border), edge bands (BLEND px), and interior. Feather at the band↔interior boundary with alpha-weighted averaging.

**Edge compatibility:**
- ✅ **All seams match** — the 1px strips that form the tile boundaries are computed to be identical for tiles sharing the same colour pair
- ✅ **Interior matches edges** by construction (minimum-MSE search)
- ⚠️ The interior→band feather is cosmetic; at the critical 1px boundary, all tiles sharing a colour pair use exactly the same pixels

**Verdict:** Excellent results. Requires more precompute time (scanning source for best patches) but the 16-tile set is generated once and used at runtime with zero overhead.

**Why smaller tiles help:** A smaller tile fits more candidate positions in the source, giving the search more options. For a 1024×1024 source, a 48×48 tile has ~900K candidate interior positions vs ~6K for 192×192. More candidates = lower MSE.

**Known limitation — Stratified search tradeoff:** The stratified search guarantees distinct tiles but means colour-pair variants that share a corner (e.g., top pairs 00 and 01 both have TL=0) come from different source rows. After corner consistency averaging, the 1px corner pixel is a blend of those rows. The pixel-1 adjacent edge pixel is from a single source region. This creates a 1-pixel potential discontinuity at corners, invisible for natural textures but theoretically present.

---

## Algorithm 3: Wei's Tile Bank (Wei & Levoy 2000 / Wei 2004)

Instead of exactly 16 tiles, precompute a **large set of candidate tiles** for each corner class.

**Method:**
1. Generate many candidate tiles for each of the 16 corner permutations by sampling the source at random offsets.
2. Score each candidate by edge-MSE against the tiles it's most likely to be placed next to.
3. Keep only the top N candidates per class (e.g., 10–30 per class = 160–480 total tiles).
4. At runtime, when placing a tile, pick from the candidates the one that best matches already-placed neighbours.

**Edge compatibility:**
- ✅ **Near-perfect** — the runtime selection can pick the ideal tile for each context
- ⚠️ Larger memory footprint (more tile textures to load)

**Verdict:** Used by many game terrain systems. Higher quality but more complex pipeline.

---

## Algorithm 4: Image Quilting (Efros & Freeman 2001)

Runtime texture synthesis rather than precomputed tiles.

**Method:**
1. For each grid cell, cut a rectangular patch from the source at a random offset.
2. At boundaries with already-placed patches, compute a **minimum-error cut path** through the overlapping region using dynamic programming (shortest path through the pixel-difference surface).
3. The cut follows paths of minimum colour difference, so edges merge invisibly.

**Edge compatibility:** ✅ **Near-perfect** — the cut path naturally avoids visible seams

**Verdict:** No Wang tile system needed; seamless by construction. But requires runtime computation and doesn't use the corner-colour system for gameplay logic (e.g., terrain typing).

---

## Algorithm 5: Hybrid Offset Search

A middle ground between Algorithm 1 and Algorithm 2 — still uses the quadrant-compositing approach but searches for optimal quadrant positions.

**Method:**
1. Instead of splitting at the exact centre, search for the optimal split point (dx, dy) that minimizes edge-MSE for colour-1 seams.
2. The source is split at `(W/2 + dx, H/2 + dy)` instead of `(W/2, H/2)`.
3. Same diagonal-swap assembly as Algorithm 1, but with better-optimized quadrant boundaries.

**Edge compatibility:**
- ✅ Improves colour-1 seams by finding a split point where edge-matching is naturally better
- ❌ Still not guaranteed to match (no search for strip-level consistency)

**Verdict:** Easy upgrade to the current code; moderate quality improvement.

---

## Summary Table

| Algorithm | Seam quality | Tile count | Precompute | Runtime | Complexity |
|-----------|-------------|-----------|------------|---------|-----------|
| **1. Diagonal swap** | Poor (colour-1) | 16 | None | None | Trivial |
| **2. Cohen search** | Good | 16 | High (scan source) | None | Medium |
| **3. Wei tile bank** | Very good | 160–480 | High | Low | High |
| **4. Image Quilting** | Near-perfect | — | None | Medium | Medium |
| **5. Hybrid offset** | Moderate | 16 | Low | None | Low |

**Recommendation:** Algorithm 2 (Cohen et al.) offers the best quality-to-complexity ratio for this project. It keeps the 16-tile system, requires no runtime changes, and the precomputation runs once per terrain texture.
