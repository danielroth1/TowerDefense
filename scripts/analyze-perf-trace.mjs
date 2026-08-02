#!/usr/bin/env node
/**
 * Analyze a Chrome DevTools performance trace (JSON) and report:
 *   - Effective frame rate (FPS) and frame-time distribution
 *   - Main-thread busy time (RunTask) vs GPU / compositor work
 *   - JS function-level cost from `devtools.timeline` FunctionCall events
 *     (and full V8 CPU profiler samples if the trace contains them)
 *
 * Usage:
 *   node scripts/analyze-perf-trace.mjs <trace.json> [topN]
 *
 * Compatible with traces produced by Chrome DevTools MCP
 * `performance_start_trace` and `chrome://tracing`.
 */
import fs from 'fs';

const file = process.argv[2];
const topN = parseInt(process.argv[3] || '25', 10);
if (!file) {
  console.error('Usage: node scripts/analyze-perf-trace.mjs <trace.json> [topN]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents || [];

// ── 1. Collect V8 profile nodes + samples (if present) ───────────────────
// ProfileChunk events carry a nested `cpuProfile` ({ nodes, samples }) plus a
// parallel `timeDeltas` array (µs per sample). Nodes are incremental across
// chunks, so we merge them into one id-keyed tree.
const nodes = new Map();
const samples = [];
for (const ev of events) {
  const cat = ev.cat || '';
  if (!cat.includes('v8.cpu_profiler') || ev.name !== 'ProfileChunk') continue;
  const data = ev.args && ev.args.data;
  if (!data) continue;
  const cp = data.cpuProfile;
  if (cp && Array.isArray(cp.nodes)) {
    for (const n of cp.nodes) {
      const cf = n.callFrame || {};
      nodes.set(n.id, {
        name: cf.functionName || '(anonymous)',
        url: cf.url || '',
        line: (cf.lineNumber ?? -1) + 1,
        parent: n.parent,
      });
    }
  }
  if (cp && Array.isArray(cp.samples) && Array.isArray(data.timeDeltas)) {
    const len = Math.min(cp.samples.length, data.timeDeltas.length);
    for (let i = 0; i < len; i++) {
      samples.push({ nodeId: cp.samples[i], deltaUs: data.timeDeltas[i] });
    }
  }
}

// ── 2. Frame rate from AnimationFrame::Script::Execute ───────────────────
const scriptFrames = events
  .filter((e) => e.name === 'AnimationFrame::Script::Execute')
  .map((e) => e.ts)
  .sort((a, b) => a - b);

function reportFps() {
  if (scriptFrames.length < 2) {
    console.log('No AnimationFrame events found — cannot compute FPS.');
    return;
  }
  const totalMs = (scriptFrames[scriptFrames.length - 1] - scriptFrames[0]) / 1000;
  const n = scriptFrames.length;
  const fps = (n - 1) / (totalMs / 1000);
  const intervals = [];
  for (let i = 1; i < n; i++) intervals.push((scriptFrames[i] - scriptFrames[i - 1]) / 1000);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const over16 = intervals.filter((i) => i > 16.7).length;
  const over33 = intervals.filter((i) => i > 33.4).length;
  const pct = (p) => intervals.slice().sort((a, b) => a - b)[Math.floor(p / 100 * (intervals.length - 1))];
  console.log(`Frames (rAF):        ${n}`);
  console.log(`Trace span:          ${totalMs.toFixed(0)} ms`);
  console.log(`Effective FPS:       ${fps.toFixed(1)}`);
  console.log(`Avg frame interval:  ${avg.toFixed(2)} ms`);
  console.log(`p50 frame interval:  ${pct(50).toFixed(2)} ms`);
  console.log(`p95 frame interval:  ${pct(95).toFixed(2)} ms`);
  console.log(`p99 frame interval:  ${pct(99).toFixed(2)} ms`);
  console.log(`Frames > 16.7ms:     ${over16} (${(over16 / intervals.length * 100).toFixed(1)}%)`);
  console.log(`Frames > 33.4ms:     ${over33} (${(over33 / intervals.length * 100).toFixed(1)}%)`);
}

// ── 3. RunTask / main-thread busy time ───────────────────────────────────
const runTasks = events.filter((e) => e.name === 'RunTask' && typeof e.dur === 'number');
const gpuTasks = events.filter((e) => e.name === 'GPUTask' && typeof e.dur === 'number');
const totalRunMs = runTasks.reduce((a, e) => a + e.dur, 0) / 1000;
const totalGpuMs = gpuTasks.reduce((a, e) => a + e.dur, 0) / 1000;

// ── 4. JS FunctionCall attribution ───────────────────────────────────────
const fcByFn = new Map();
for (const e of events) {
  if (e.name !== 'FunctionCall' || typeof e.dur !== 'number') continue;
  const d = e.args?.data || {};
  const key = `${d.functionName || '(anonymous)'} :: ${(d.url || '').split('/').pop() || '(native)'}${d.lineNumber != null ? ':' + (d.lineNumber + 1) : ''}`;
  const rec = fcByFn.get(key) || { dur: 0, count: 0, url: d.url || '', fn: d.functionName || '(anonymous)' };
  rec.dur += e.dur;
  rec.count++;
  fcByFn.set(key, rec);
}

const fmt = (ms) => (ms / 1000).toFixed(1) + ' s';

console.log(`\nTrace: ${file}`);
console.log('─'.repeat(92));
console.log('FRAME RATE');
console.log('─'.repeat(92));
reportFps();

console.log('\n' + '─'.repeat(92));
console.log('MAIN-THREAD vs GPU');
console.log('─'.repeat(92));
console.log(`RunTask (main-thread frames): ${runTasks.length} tasks, ${fmt(totalRunMs)} total`);
console.log(`GPUTask:                       ${gpuTasks.length} tasks, ${fmt(totalGpuMs)} total`);
if (runTasks.length) {
  const avgTask = totalRunMs / runTasks.length;
  console.log(`Avg RunTask duration:          ${avgTask.toFixed(2)} ms`);
  const sorted = runTasks.map((e) => e.dur / 1000).sort((a, b) => b - a);
  console.log(`Slowest RunTask:               ${sorted[0].toFixed(2)} ms`);
  console.log(`RunTasks > 33ms (missed 2+ frames): ${sorted.filter((d) => d > 33).length} (${(sorted.filter((d) => d > 33).length / sorted.length * 100).toFixed(1)}%)`);
}

console.log('\n' + '─'.repeat(92));
console.log('TOP JS FUNCTIONS (total duration across trace)');
console.log('─'.repeat(92));
console.log('Total'.padEnd(10) + 'Avg'.padEnd(10) + 'Calls'.padEnd(8) + 'Function');
console.log('─'.repeat(92));
const fcRows = [...fcByFn.values()].sort((a, b) => b.dur - a.dur).slice(0, topN);
for (const r of fcRows) {
  console.log(
    (r.dur / 1000).toFixed(1).padEnd(10) +
    (r.dur / r.count / 1000).toFixed(2).padEnd(10) +
    String(r.count).padEnd(8) +
    `${r.fn}  <${(r.url || 'native').split('/').pop()}>`
  );
}

// ── 5. V8 samples (if present) ───────────────────────────────────────────
if (samples.length > 0) {
  const selfUs = new Map();
  const inclUs = new Map();
  let totalUs = 0;
  for (const s of samples) {
    const d = s.deltaUs;
    if (d <= 0) continue;
    totalUs += d;
    selfUs.set(s.nodeId, (selfUs.get(s.nodeId) || 0) + d);
    let cur = s.nodeId, guard = 0;
    while (cur != null && nodes.has(cur) && guard++ < 1000) {
      inclUs.set(cur, (inclUs.get(cur) || 0) + d);
      const parent = nodes.get(cur).parent;
      if (parent == null) break;
      cur = parent;
    }
  }
  const totalMs = totalUs / 1000;
  console.log('\n' + '─'.repeat(92));
  console.log(`V8 CPU PROFILE SAMPLES (${samples.length} samples, ${totalMs.toFixed(0)} ms sampled)`);
  console.log('─'.repeat(92));
  console.log('By INCLUSIVE time:');
  const rows = [...inclUs.entries()]
    .map(([id, incl]) => ({ id, name: nodes.get(id)?.name || '(anonymous)', url: nodes.get(id)?.url || '', line: nodes.get(id)?.line || 0, inclMs: incl / 1000, selfMs: (selfUs.get(id) || 0) / 1000 }))
    .sort((a, b) => b.inclMs - a.inclMs)
    .slice(0, topN);
  for (const r of rows) {
    const pct = (r.inclMs / totalMs * 100).toFixed(1) + '%';
    const loc = r.url ? r.url.split('/').pop() : '(native)';
    console.log(`${(r.inclMs / 1000).toFixed(2).padEnd(8)}s ${pct.padEnd(7)} ${(r.selfMs / 1000).toFixed(2).padEnd(7)}s ${(r.name.length > 44 ? r.name.slice(0, 43) + '…' : r.name).padEnd(45)} ${loc}`);
  }
  console.log('\nBy SELF time:');
  const bySelf = [...selfUs.entries()]
    .map(([id, self]) => ({ id, name: nodes.get(id)?.name || '(anonymous)', url: nodes.get(id)?.url || '', line: nodes.get(id)?.line || 0, selfMs: self / 1000 }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN);
  for (const r of bySelf) {
    const pct = (r.selfMs / totalMs * 100).toFixed(1) + '%';
    const loc = r.url ? r.url.split('/').pop() : '(native)';
    console.log(`${(r.selfMs / 1000).toFixed(2).padEnd(8)}s ${pct.padEnd(7)} ${(r.name.length > 44 ? r.name.slice(0, 43) + '…' : r.name).padEnd(45)} ${loc}`);
  }
}
console.log('');
