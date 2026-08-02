#!/usr/bin/env node
/**
 * Analyze a Firefox Profiler capture (Gecko profile JSON) and report:
 *   - Frame rate from requestAnimationFrame callback markers
 *   - Main-thread CPU busy % (threadCPUDelta, µs) and sample classification
 *   - GC overview
 *   - Top JS functions (self + inclusive) from stack samples
 *
 * Usage:
 *   node scripts/analyze-firefox-profile.mjs <profile.json> [topN]
 *
 * Compatible with profiles saved from the Firefox Profiler / Gecko sampler
 * (docs/perf/Firefox *.json).
 *
 * Notes on this format:
 *   - `threadCPUDelta` is in MICROSECONDS per sample.
 *   - `funcTable.isJS` is a boolean.
 *   - With `meta.stackwalk: 0` + no JIT symbolication, Ion-compiled JS shows
 *     up as raw code addresses (typically 0x18… / 0x0x… regions), not names.
 */
import fs from 'fs';

const file = process.argv[2];
const topN = parseInt(process.argv[3] || '30', 10);
if (!file) {
  console.error('Usage: node scripts/analyze-firefox-profile.mjs <profile.json> [topN]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const str = raw.shared.stringArray;
const funcT = raw.shared.funcTable;
const frameT = raw.shared.frameTable;
const stackT = raw.shared.stackTable;
const resT = raw.shared.resourceTable;
const cats = raw.meta.categories;
const s = (i) => str[i] ?? `#${i}`;

const funcName = (fid) => s(funcT.name[fid]);
const funcIsJS = (fid) => funcT.isJS[fid] === true;
const funcRes = (fid) => (resT.name[funcT.resource[fid]] ?? '');
const frameFunc = (fid) => frameT.func[fid];
const frameCat = (fid) => frameT.category[fid];
const catName = (c) => (Number.isInteger(c) && cats[c] ? cats[c].name : 'Unknown');

function stackFrames(stackIdx) {
  const frames = [];
  let stk = stackIdx;
  let guard = 0;
  const seen = new Set();
  while (Number.isInteger(stk) && stk >= 0 && guard++ < 100000) {
    if (seen.has(stk)) break;
    seen.add(stk);
    const f = stackT.frame[stk];
    if (f === undefined) break;
    frames.push(f);
    stk = stackT.prefixOffset[stk];
  }
  return frames;
}
function frameFuncName(fid) {
  const f = frameFunc(fid);
  return f === undefined ? null : funcName(f);
}
function frameFuncIsJS(fid) {
  const f = frameFunc(fid);
  return f === undefined ? false : funcIsJS(f);
}

function jsSamples(t) {
  let n = 0;
  const st = t.samples.stack;
  for (let i = 0; i < st.length; i++) {
    for (const f of stackFrames(st[i])) if (frameFuncIsJS(f)) { n++; break; }
  }
  return n;
}

let game = null;
for (const t of raw.threads) {
  if (t.name !== 'GeckoMain') continue;
  const js = jsSamples(t);
  if (js > 0 && (!game || js > game.js)) game = { thread: t, js };
}
if (!game) { console.error('No GeckoMain thread with JS samples found.'); process.exit(1); }

const t = game.thread;
const time = t.samples.time;
const cpuUs = t.samples.threadCPUDelta;   // µs
const stacks = t.samples.stack;
const weight = t.samples.weight;
const wType = t.samples.weightType;
const t0 = time[0], t1 = time[time.length - 1];
const spanMs = t1 - t0;

// per-sample CPU ms (µs -> ms)
const cpuMs = cpuUs.map((v) => (v && v > 0 ? v / 1000 : 0));
let busyMs = 0;
for (let i = 0; i < time.length; i++) busyMs += cpuMs[i] ?? 0;
// per-sample wall time (ms) — use interval to next sample
const wallMs = [];
for (let i = 0; i < time.length - 1; i++) wallMs.push(time[i + 1] - time[i]);
wallMs.push(wallMs.length ? wallMs[wallMs.length - 1] : 1);

console.log(`Profile: ${file}`);
console.log(`Game thread: GeckoMain pid ${t.pid} (${game.js} named-JS samples)`);
console.log(`Samples: ${time.length}  |  span: ${spanMs.toFixed(0)} ms`);
console.log(`CPU busy: ${busyMs.toFixed(0)} ms (${(busyMs / spanMs * 100).toFixed(1)}% of span)`);

// ── FPS from rAF markers within the recorded (sampled) window ────────────
const rafMarkers = [];
const sMin = t0, sMax = t1;
for (let i = 0; i < t.markers.length; i++) {
  if (s(t.markers.name[i]) !== 'requestAnimationFrame callbacks') continue;
  const ts = t.markers.startTime[i];
  if (ts >= sMin && ts <= sMax) rafMarkers.push(ts);
}
rafMarkers.sort((a, b) => a - b);
if (rafMarkers.length >= 3) {
  const iv = [];
  for (let i = 1; i < rafMarkers.length; i++) iv.push(rafMarkers[i] - rafMarkers[i - 1]);
  const fps = (rafMarkers.length - 1) / (iv.reduce((a, b) => a + b, 0) / 1000);
  const pct = (p) => iv.slice().sort((a, b) => a - b)[Math.floor(p / 100 * (iv.length - 1))];
  console.log('─'.repeat(92));
  console.log('FRAME RATE (rAF callbacks inside recorded window)');
  console.log('─'.repeat(92));
  console.log(`rAF callbacks:        ${rafMarkers.length}`);
  console.log(`Effective FPS:        ${fps.toFixed(1)}`);
  console.log(`Avg / p50 / p95 / p99: ${(iv.reduce((a, b) => a + b, 0) / iv.length).toFixed(2)} / ${pct(50).toFixed(2)} / ${pct(95).toFixed(2)} / ${pct(99).toFixed(2)} ms`);
  console.log(`Frames > 16.7ms:      ${iv.filter((x) => x > 16.7).length} (${(iv.filter((x) => x > 16.7).length / iv.length * 100).toFixed(1)}%)`);
  console.log(`Frames > 33.3ms:      ${iv.filter((x) => x > 33.3).length} (${(iv.filter((x) => x > 33.3).length / iv.length * 100).toFixed(1)}%)`);
}

// ── classify each sample ─────────────────────────────────────────────────
const cls = new Map();
const JIT_RE = /^0x[0-9a-f]+$/i;
const WAIT_RE = /(cvwait|mach_msg|nanosleep|ulock|semaphore|kevent|psynch|poll|select|read|__wait|cond_wait|usleep|accept|recv|sendmsg|write)/;
const GC_RE = /js::gc::|GC|Sweep|MajorGC|MinorGC|GCMarker|Marking|nsCycleCollector/i;
const TRIG_RE = /fdlibm_/;
for (let i = 0; i < stacks.length; i++) {
  const frames = stackFrames(stacks[i]);
  const w = wallMs[i];
  let jsNamed = false, jsJit = false, gc = false, trig = false;
  const leaves = [];
  for (const f of frames) {
    const nm = frameFuncName(f);
    if (nm) leaves.push(nm);
    if (frameFuncIsJS(f)) jsNamed = true;
    if (GC_RE.test(nm)) gc = true;
    if (TRIG_RE.test(nm)) trig = true;
  }
  if (!jsNamed && leaves.length) {
    if (leaves.some((n) => JIT_RE.test(n))) jsJit = true;
  }
  let label;
  if (jsNamed) label = 'JS (named)';
  else if (jsJit) label = 'JS JIT (raw addr)';
  else if (gc) label = 'GC / CC';
  else if (trig) label = 'trig math';
  else if (leaves.length && WAIT_RE.test(leaves[0])) label = 'wait/idle';
  else if (leaves.length && leaves[0] === '_platform_memmove') label = 'memmove';
  else if (leaves.length && (leaves[0] === 'mach_msg2_trap' || leaves[0] === '__sendmsg')) label = 'IPC (send/recv)';
  else label = 'other native';
  cls.set(label, (cls.get(label) || 0) + w);
}
console.log('─'.repeat(92));
console.log('MAIN-THREAD TIME BY SAMPLE CLASS (wall time)');
console.log('─'.repeat(92));
for (const [c, v] of [...cls.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${(v / 1000).toFixed(2).padEnd(9)}s ${(v / spanMs * 100).toFixed(1).padEnd(6)}% ${c}`);
}

// ── GC ───────────────────────────────────────────────────────────────────
const gcMarks = [];
for (let i = 0; i < t.markers.length; i++) {
  const n = s(t.markers.name[i]);
  if (n === 'GCMinor' || n === 'GCSlice') gcMarks.push({ n, st: t.markers.startTime[i], e: t.markers.endTime[i] ?? t.markers.startTime[i] });
}
if (gcMarks.length) {
  let gcMs = 0;
  const byName = {};
  for (const g of gcMarks) { gcMs += g.e - g.st; byName[g.n] = (byName[g.n] || 0) + (g.e - g.st); }
  console.log('─'.repeat(92));
  console.log('GARBAGE COLLECTION (marker durations)');
  console.log('─'.repeat(92));
  console.log(`${gcMarks.length} GC events, ${(gcMs / 1000).toFixed(2)}s total (${(gcMs / spanMs * 100).toFixed(1)}% of span)`);
  for (const [n, v] of Object.entries(byName)) console.log(`  ${n}: ${(v / 1000).toFixed(2)}s`);
}

// ── JS function attribution (named JS frames only) ───────────────────────
const selfMs = new Map();
const inclMs = new Map();
for (let i = 0; i < stacks.length; i++) {
  const w = wallMs[i];
  if (w <= 0) continue;
  const frames = stackFrames(stacks[i]);
  const jsFrames = [];
  for (const f of frames) if (frameFuncIsJS(f)) jsFrames.push(f);
  if (!jsFrames.length) continue;
  selfMs.set(jsFrames[0], (selfMs.get(jsFrames[0]) || 0) + w);
  for (const f of jsFrames) inclMs.set(f, (inclMs.get(f) || 0) + w);
}
const totalJS = [...selfMs.values()].reduce((a, b) => a + b, 0);

function fmtFn(fid) {
  const nm = funcName(fid);
  const line = funcT.lineNumber[fid];
  const res = funcRes(fid);
  const loc = res ? String(res).split('/').pop() : '';
  return `${nm} <${loc}${line ? ':' + line : ''}>`;
}

if (totalJS > 0) {
  console.log('─'.repeat(92));
  console.log(`NAMED JS FUNCTIONS (${(totalJS / 1000).toFixed(1)}s of wall time in named JS)`);
  console.log('─'.repeat(92));
  console.log('By INCLUSIVE:');
  for (const [fid, v] of [...inclMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
    const self = selfMs.get(fid) || 0;
    console.log(`${(v / 1000).toFixed(2).padEnd(8)}s ${(v / totalJS * 100).toFixed(1).padEnd(6)}%  self ${(self / 1000).toFixed(2).padEnd(7)}s ${fmtFn(fid)}`);
  }
  console.log('\nBy SELF:');
  for (const [fid, v] of [...selfMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
    console.log(`${(v / 1000).toFixed(2).padEnd(8)}s ${(v / totalJS * 100).toFixed(1).padEnd(6)}% ${fmtFn(fid)}`);
  }
} else {
  console.log('\nNo named JS frames found (all JS is JIT-raw).');
}

// ── slowest CPU runs ─────────────────────────────────────────────────────
console.log('─'.repeat(92));
console.log('LONGEST MAIN-THREAD CPU RUNS (contiguous busy samples, CPU ms)');
console.log('─'.repeat(92));
let runs = [];
let start = null, runBusy = 0, runWall = 0;
for (let i = 0; i < time.length; i++) {
  const busy = cpuMs[i] > 0;
  if (busy) {
    if (start === null) start = i;
    runBusy += cpuMs[i];
    runWall += wallMs[i];
  } else if (start !== null) {
    runs.push({ startMs: time[start] - t0, cpu: runBusy, wall: runWall });
    start = null; runBusy = 0; runWall = 0;
  }
}
runs.sort((a, b) => b.cpu - a.cpu).slice(0, 15).forEach((r) => {
  console.log(`  @${r.startMs.toFixed(0).padEnd(7)}ms  cpu ${r.cpu.toFixed(1).padEnd(7)}ms  wall ${r.wall.toFixed(1)}ms`);
});

// ── helper thread overview ───────────────────────────────────────────────
console.log('─'.repeat(92));
console.log('OTHER THREADS (CPU ms, µs->ms)');
console.log('─'.repeat(92));
for (const th of raw.threads) {
  if (th === t) continue;
  const tt = th.samples.time, cd = th.samples.threadCPUDelta;
  let c = 0;
  for (let i = 0; i < cd.length; i++) if (cd[i] && cd[i] > 0) c += cd[i] / 1000;
  const sp = tt.length ? (tt[tt.length - 1] - tt[0]) : 0;
  console.log(`  ${th.name} pid ${th.pid}: CPU ${c.toFixed(0)} ms / ${sp.toFixed(0)} ms span (${sp ? (c / sp * 100).toFixed(1) : 0}%)`);
}
console.log('');
