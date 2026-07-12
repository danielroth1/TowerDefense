/**
 * Simple Node.js server for the AI Tile Generator tool.
 * Serves the HTML UI and proxies requests to fal.ai with the API key.
 *
 * Usage: node tools/tile-generator/server.mjs
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3456;
const FAL_KEY = process.env.FAL_AI_KEY || '';
const OUTPUT_DIR = join(__dirname, '..', '..', 'public', 'assets', 'tiles');
const ARCHIVE_DIR = join(__dirname, '..', '..', 'archive', 'tiles');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

// Pricing cache — fetched live from fal.ai's Platform API.
// Cache TTL: 1 hour (pricing doesn't change frequently).
const _pricingCache = new Map(); // endpoint_id → { unit_price, unit, currency, fetched_at }

async function fetchPricingFromFal(endpointIds) {
  if (!FAL_KEY) return {};
  // Filter out cached entries (fetched within the last hour)
  const now = Date.now();
  const toFetch = endpointIds.filter(id => {
    const cached = _pricingCache.get(id);
    return !cached || (now - cached.fetched_at) > 3_600_000;
  });

  if (toFetch.length === 0) {
    // All cached — return from cache
    const result = {};
    for (const id of endpointIds) result[id] = _pricingCache.get(id);
    return result;
  }

  // Fetch in batches of 50 (API limit)
  const results = {};
  for (let i = 0; i < toFetch.length; i += 50) {
    const batch = toFetch.slice(i, i + 50);
    const url = `https://api.fal.ai/v1/models/pricing?${batch.map(id => `endpoint_id=${encodeURIComponent(id)}`).join('&')}`;
    try {
      const resp = await fetch(url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      if (!resp.ok) {
        console.error(`[pricing] HTTP ${resp.status} fetching batch of ${batch.length} IDs`);
        continue;
      }
      const data = await resp.json();
      for (const p of (data.prices || [])) {
        const entry = { ...p, fetched_at: now };
        _pricingCache.set(p.endpoint_id, entry);
        results[p.endpoint_id] = entry;
      }
    } catch (err) {
      console.error(`[pricing] Error fetching batch:`, err.message);
    }
  }

  // Merge with cache for any IDs that weren't in the fetch batches
  for (const id of endpointIds) {
    if (!results[id]) results[id] = _pricingCache.get(id) || null;
  }

  return results;
}

function classifyPricing(p) {
  if (!p || p.unit_price == null) return { cost: '—', unit: '', type: 'unknown', note: 'No price info' };
  const price = `$${p.unit_price.toFixed(p.unit_price < 0.01 ? 4 : 3)}`;
  // Real fal.ai unit values: "megapixels", "images", "units", "compute seconds"
  let unitLabel, type;
  switch (p.unit) {
    case 'megapixels':     unitLabel = '/MP';  type = 'megapixel'; break;
    case 'images':         unitLabel = '/img'; type = 'image';     break;
    case 'units':          unitLabel = '/unit';type = 'per-unit';  break; // one image = multiple units, effectively more expensive
    case 'compute seconds':unitLabel = '/sec'; type = 'gpu';       break;
    default:               unitLabel = `/${p.unit || 'unit'}`; type = 'unknown'; break;
  }
  return { cost: price, unit: unitLabel, type, note: `per ${p.unit || 'unit'}` };
}

function serveFile(res, path, mime) {
  try {
    const data = readFileSync(path);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

/** Return a unique archive path for a filename, appending _2, _3, etc. if needed. */
function uniqueArchivePath(fname) {
  const ext = extname(fname);
  const base = fname.slice(0, -ext.length);

  let candidate = join(ARCHIVE_DIR, fname);
  if (!existsSync(candidate)) return candidate;

  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(ARCHIVE_DIR, `${base}_${n}${ext}`);
    n++;
  }
  return candidate;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ─── Serve HTML tool ─────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }

  // ─── API: list tiles ─────────────────────────────────────────────────
  if (pathname === '/api/tiles' && req.method === 'GET') {
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
    const files = readdirSync(OUTPUT_DIR)
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map((f) => {
        const full = join(OUTPUT_DIR, f);
        const size = statSync(full).size;
        return { name: f, path: `/api/tiles/${f}`, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return json(res, files);
  }

  // ─── API: serve tile image ──────────────────────────────────────────
  if (pathname.startsWith('/api/tiles/') && req.method === 'GET') {
    const fname = decodeURIComponent(pathname.slice('/api/tiles/'.length));
    const safe = join(OUTPUT_DIR, fname);
    if (!safe.startsWith(OUTPUT_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    const ext = extname(fname).toLowerCase();
    return serveFile(res, safe, MIME[ext] || 'image/png');
  }

  // ─── API: delete tile ───────────────────────────────────────────────
  if (pathname.startsWith('/api/tiles/') && req.method === 'DELETE') {
    const fname = decodeURIComponent(pathname.slice('/api/tiles/'.length));
    const safe = join(OUTPUT_DIR, fname);
    if (!safe.startsWith(OUTPUT_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      unlinkSync(safe);
      return json(res, { ok: true });
    } catch {
      return json(res, { ok: false, error: 'Delete failed' }, 500);
    }
  }

  // ─── API: generate tile ─────────────────────────────────────────────
  if (pathname === '/api/generate' && req.method === 'POST') {
    if (!FAL_KEY) return json(res, { error: 'FAL_AI_KEY not set in environment. Export it: export FAL_AI_KEY=your-key' }, 500);

    const body = await readBody(req);
    let params;
    try { params = JSON.parse(body); } catch {
      return json(res, { error: 'Invalid JSON' }, 400);
    }

    const { model, prompt, tileName, width, height } = params;
    if (!prompt || !tileName) return json(res, { error: 'Missing prompt or tileName' }, 400);

    const w = width || 512;
    const h = height || 512;

    try {
      const result = await callFalAI(model, prompt, w, h);
      if (!result.imageUrl) {
        return json(res, { error: 'No image returned from fal.ai' }, 500);
      }

      // Download image
      const imgResp = await fetch(result.imageUrl);
      const buffer = Buffer.from(await imgResp.arrayBuffer());

      // Ensure output and archive directories exist
      if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
      if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

      const fname = tileName.replace(/[^a-z0-9_-]/gi, '_') + '.png';
      const filePath = join(OUTPUT_DIR, fname);

      // Archive existing tile if present (don't overwrite)
      if (existsSync(filePath)) {
        const archivePath = uniqueArchivePath(fname);
        renameSync(filePath, archivePath);
        console.log(`[archive] Moved existing "${fname}" → archive/tiles/${archivePath.split('/').pop()}`);
      }

      writeFileSync(filePath, buffer);

      return json(res, {
        ok: true,
        name: fname,
        path: `/api/tiles/${fname}`,
        size: buffer.length,
      });
    } catch (err) {
      console.error('[server] Generate error:', err);
      return json(res, { error: String(err) }, 500);
    }
  }

  // ─── API: remove background ─────────────────────────────────────────
  if (pathname === '/api/remove-bg' && req.method === 'POST') {
    if (!FAL_KEY) return json(res, { error: 'FAL_AI_KEY not set in environment. Export it: export FAL_AI_KEY=your-key' }, 500);

    const body = await readBody(req);
    let params;
    try { params = JSON.parse(body); } catch {
      return json(res, { error: 'Invalid JSON' }, 400);
    }

    const { tileName, bgModel } = params;
    if (!tileName) return json(res, { error: 'Missing tileName' }, 400);

    // Validate model against allowlist
    const ALLOWED_BG_MODELS = ['fal-ai/imageutils/rembg', 'fal-ai/bria/background/remove'];
    const resolvedBgModel = ALLOWED_BG_MODELS.includes(bgModel) ? bgModel : ALLOWED_BG_MODELS[0];

    // Sanitize — no path separators allowed
    const fname = tileName.replace(/[^a-z0-9_.-]/gi, '_');
    const filePath = join(OUTPUT_DIR, fname);
    if (!filePath.startsWith(OUTPUT_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

    if (!existsSync(filePath)) {
      return json(res, { error: `File not found: ${fname}` }, 404);
    }

    try {
      const fileBuffer = readFileSync(filePath);
      // Detect JPEG vs PNG from magic bytes
      const mime = (fileBuffer[0] === 0xFF && fileBuffer[1] === 0xD8) ? 'image/jpeg' : 'image/png';
      const dataUri = `data:${mime};base64,${fileBuffer.toString('base64')}`;

      console.log(`[bg-remove] Processing "${fname}" (${fileBuffer.length} bytes, ${mime}) via ${resolvedBgModel}...`);
      const result = await callFalBgRemove(dataUri, resolvedBgModel);

      const imgResp = await fetch(result.imageUrl);
      const outBuffer = Buffer.from(await imgResp.arrayBuffer());

      // Overwrite in place — result is always PNG with alpha channel
      writeFileSync(filePath, outBuffer);
      console.log(`[bg-remove] Saved "${fname}" with background removed (${outBuffer.length} bytes)`);

      return json(res, { ok: true, name: fname, size: outBuffer.length });
    } catch (err) {
      console.error('[bg-remove] Error:', err);
      return json(res, { error: String(err) }, 500);
    }
  }

  // ─── API: list text-to-image models from fal.ai ──────────────────────
  if (pathname === '/api/models' && req.method === 'GET') {
    if (!FAL_KEY) return json(res, { error: 'FAL_AI_KEY not set' }, 500);
    try {
      const resp = await fetch('https://api.fal.ai/v1/models?limit=500', {
        headers: { 'Authorization': `Key ${FAL_KEY}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} from fal.ai`);
      const data = await resp.json();
      const t2i = (data.models || [])
        .filter(m => m.metadata?.category === 'text-to-image')
        .map(m => {
          const eid = m.endpoint_id;
          let dn = m.metadata.display_name
            .replace(/ Text To Image$/, '')
            .replace(/ API$/, '');
          return {
            id: eid,
            name: dn,
            description: (m.metadata.description || '').split('\n')[0].slice(0, 200),
            status: m.metadata?.status || 'unknown',
            pricing: null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      // Ensure the 4 hardcoded quick-select models are always present.
      // They may be inactive or miscategorized in the API — include them
      // anyway so the browser list is exhaustive.
      const QUICK_SELECT_IDS = [
        'fal-ai/fast-sdxl',
        'fal-ai/flux/schnell',
        'fal-ai/flux/dev',
        'fal-ai/stable-diffusion-v3.5',
      ];
      const existingIds = new Set(t2i.map(m => m.id));
      for (const id of QUICK_SELECT_IDS) {
        if (!existingIds.has(id)) {
          const name = id.replace('fal-ai/', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          t2i.push({
            id,
            name,
            description: 'Quick-select model (not listed as text-to-image by fal.ai API)',
            status: 'unknown',
            pricing: null,
          });
        }
      }
      t2i.sort((a, b) => a.name.localeCompare(b.name));

      return json(res, { models: t2i });
    } catch (err) {
      console.error('[models] Error:', err);
      return json(res, { error: String(err) }, 500);
    }
  }

  // ─── API: fetch live pricing from fal.ai Platform API ────────────────
  if (pathname === '/api/pricing' && req.method === 'GET') {
    if (!FAL_KEY) return json(res, { error: 'FAL_AI_KEY not set' }, 500);
    const idsParam = url.searchParams.get('ids');
    if (!idsParam) return json(res, { error: 'Missing ?ids= comma-separated endpoint IDs' }, 400);
    const ids = [...new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean))];
    if (ids.length === 0) return json(res, { error: 'No valid IDs' }, 400);
    if (ids.length > 200) return json(res, { error: 'Too many IDs (max 200)' }, 400);

    try {
      const raw = await fetchPricingFromFal(ids);
      const prices = {};
      for (const id of ids) {
        prices[id] = raw[id] ? classifyPricing(raw[id]) : { cost: '—', unit: '', type: 'unknown', note: 'No price info' };
      }
      return json(res, { prices });
    } catch (err) {
      console.error('[pricing] Error:', err);
      return json(res, { error: String(err) }, 500);
    }
  }

// Estimate cache — short-lived (30s) to avoid hammering fal.ai on every keystroke
const _estimateCache = new Map(); // key: "model:w:h" → { estimatedCost, currency, ... }

  // ─── API: estimate generation cost ───────────────────────────────────
  if (pathname === '/api/estimate-cost' && req.method === 'POST') {
    if (!FAL_KEY) return json(res, { error: 'FAL_AI_KEY not set' }, 500);

    const body = await readBody(req);
    let params;
    try { params = JSON.parse(body); } catch {
      return json(res, { error: 'Invalid JSON' }, 400);
    }

    const { model, width, height } = params;
    if (!model) return json(res, { error: 'Missing model' }, 400);

    const w = parseInt(width) || 512;
    const h = parseInt(height) || 512;
    const megapixels = (w * h) / 1_000_000;

    // Check short-lived cache (30s TTL)
    const cacheKey = `${model}:${w}:${h}`;
    const cached = _estimateCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < 30_000) {
      return json(res, cached.data);
    }

    try {
      // First get pricing to determine the unit type
      const raw = await fetchPricingFromFal([model]);
      const priceInfo = raw[model];

      // Determine unit_quantity based on the billing unit
      let unitQuantity;
      if (priceInfo?.unit === 'megapixels') {
        unitQuantity = Math.max(0.001, megapixels);
      } else if (priceInfo?.unit === 'images' || priceInfo?.unit === 'units') {
        unitQuantity = 1;
      } else if (priceInfo?.unit === 'compute seconds') {
        unitQuantity = 1;
      } else {
        unitQuantity = Math.max(0.001, megapixels);
      }

      const resp = await fetch('https://api.fal.ai/v1/models/pricing/estimate', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${FAL_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          estimate_type: 'unit_price',
          endpoints: { [model]: { unit_quantity: parseFloat(unitQuantity.toFixed(6)) } },
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        // Rate limited — return a rough local estimate and cache it too
        if (resp.status === 429) {
          console.warn(`[estimate] Rate limited, using local estimate for ${model}`);
          const fallback = computeLocalEstimate(priceInfo, unitQuantity);
          _estimateCache.set(cacheKey, { data: fallback, ts: Date.now() });
          return json(res, fallback);
        }
        console.error(`[estimate] HTTP ${resp.status}: ${errText.slice(0, 300)}`);
        return json(res, { error: `Estimate failed: HTTP ${resp.status}` }, 500);
      }

      const data = await resp.json();
      const result = {
        estimatedCost: data.total_cost,
        currency: data.currency || 'USD',
        megapixels: parseFloat(megapixels.toFixed(4)),
        unitQuantity: parseFloat(unitQuantity.toFixed(6)),
        unit: priceInfo?.unit || 'unknown',
      };
      // Cache the result
      _estimateCache.set(cacheKey, { data: result, ts: Date.now() });
      return json(res, result);
    } catch (err) {
      console.error('[estimate] Error:', err);
      return json(res, { error: String(err) }, 500);
    }
  }

/** Compute a rough local estimate when the fal.ai estimate API is unavailable. */
function computeLocalEstimate(priceInfo, unitQuantity) {
  if (!priceInfo || priceInfo.unit_price == null) {
    return { estimatedCost: 0, currency: 'USD', megapixels: 0, unitQuantity, unit: 'unknown', local: true };
  }
  return {
    estimatedCost: parseFloat((priceInfo.unit_price * unitQuantity).toFixed(6)),
    currency: priceInfo.currency || 'USD',
    megapixels: 0,
    unitQuantity: parseFloat(unitQuantity.toFixed(6)),
    unit: priceInfo.unit || 'unknown',
    local: true,
  };
}

  // ─── API: test/health check ──────────────────────────────────────────
  if (pathname === '/api/test' && req.method === 'GET') {
    return json(res, {
      ok: true,
      falKey: FAL_KEY ? `Present (${FAL_KEY.length} chars)` : 'MISSING',
      outputDir: OUTPUT_DIR,
      outputExists: existsSync(OUTPUT_DIR),
      tileCount: existsSync(OUTPUT_DIR)
        ? readdirSync(OUTPUT_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).length
        : 0,
    });
  }

  // ─── Static files ───────────────────────────────────────────────────
  // API routes return JSON 404 for debugging; everything else returns text
  if (pathname.startsWith('/api/')) {
    return json(res, { error: 'Not found', path: pathname, method: req.method }, 404);
  }
  res.writeHead(404);
  res.end('Not found');
});

async function callFalAI(model, prompt, width, height) {
  const falModel = model || 'fal-ai/fast-sdxl';
  console.log(`[fal.ai] Generating with model "${falModel}": "${prompt.slice(0, 80)}..."`);

  // Helper: safely fetch and parse JSON with better error messages
  async function fetchJSON(url, opts) {
    const resp = await fetch(url, opts);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
    }
  }

  // Submit generation request
  const submitData = await fetchJSON(`https://queue.fal.run/${falModel}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_size: { width, height },
      num_inference_steps: falModel.includes('schnell') ? 4 : falModel.includes('flux-2') ? 8 : 28,
    }),
  });

  const requestId = submitData.request_id;
  if (!requestId) throw new Error('No request_id in fal.ai submit response: ' + JSON.stringify(submitData).slice(0, 200));
  console.log(`[fal.ai] Submitted — request_id: ${requestId}`);

  // Use the URLs returned by fal.ai — some models (like flux/schnell) use a
  // different base path than the model name (e.g. submit to /fal-ai/flux/schnell
  // but status/result URLs use /fal-ai/flux without the /schnell suffix).
  const statusUrl = submitData.status_url;
  const resultUrl = submitData.response_url;
  if (!statusUrl || !resultUrl) {
    throw new Error('Missing status_url or response_url in submit response: ' + JSON.stringify(submitData).slice(0, 200));
  }
  console.log(`[fal.ai] Status URL: ${statusUrl}`);

  // Poll for result
  for (let attempt = 1; attempt <= 120; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));

    const statusData = await fetchJSON(
      statusUrl,
      { headers: { 'Authorization': `Key ${FAL_KEY}` } },
    );

    console.log(`[fal.ai] Poll #${attempt}: ${statusData.status}`);

    if (statusData.status === 'COMPLETED') {
      const resultData = await fetchJSON(
        resultUrl,
        { headers: { 'Authorization': `Key ${FAL_KEY}` } },
      );

      const imageUrl = resultData?.images?.[0]?.url || resultData?.image?.url;
      const contentType = resultData?.images?.[0]?.content_type || 'image/png';

      if (!imageUrl) {
        console.error('[fal.ai] Result had no image URL:', JSON.stringify(resultData).slice(0, 500));
        throw new Error('No image URL in fal.ai response');
      }
      console.log(`[fal.ai] Done — image URL: ${imageUrl.slice(0, 80)}...`);
      return { imageUrl, content_type: contentType };
    }

    if (statusData.status === 'FAILED') {
      console.error('[fal.ai] Generation FAILED:', JSON.stringify(statusData));
      throw new Error(`fal.ai generation failed: ${JSON.stringify(statusData).slice(0, 300)}`);
    }
  }

  throw new Error('fal.ai generation timed out (120s)');
}

async function callFalBgRemove(imageDataUri, model = 'fal-ai/imageutils/rembg') {
  console.log(`[fal.ai] Submitting background removal to ${model}...`);

  async function fetchJSON(url, opts) {
    const resp = await fetch(url, opts);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`); }
  }

  const submitData = await fetchJSON(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image_url: imageDataUri }),
  });

  const statusUrl = submitData.status_url;
  const resultUrl = submitData.response_url;
  if (!statusUrl || !resultUrl) {
    throw new Error('Missing status_url or response_url in bg-remove response: ' + JSON.stringify(submitData).slice(0, 200));
  }
  console.log(`[fal.ai bg-remove] request_id: ${submitData.request_id}`);

  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));

    const statusData = await fetchJSON(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    console.log(`[fal.ai bg-remove] Poll #${attempt}: ${statusData.status}`);

    if (statusData.status === 'COMPLETED') {
      const resultData = await fetchJSON(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      const imageUrl = resultData?.image?.url;
      if (!imageUrl) throw new Error('No image URL in bg-remove result: ' + JSON.stringify(resultData).slice(0, 300));
      console.log(`[fal.ai bg-remove] Done — ${imageUrl.slice(0, 80)}...`);
      return { imageUrl };
    }

    if (statusData.status === 'FAILED') {
      throw new Error(`fal.ai bg-remove failed: ${JSON.stringify(statusData).slice(0, 300)}`);
    }
  }

  throw new Error('fal.ai bg-remove timed out (60s)');
}

server.listen(PORT, () => {
  console.log(`\n🎨  Tile Generator running at http://localhost:${PORT}`);
  if (!FAL_KEY) {
    console.warn('⚠️  FAL_AI_KEY not set — generation will not work.');
    console.warn('   Export it:  export FAL_AI_KEY=your-api-key\n');
  } else {
    console.log(`🔑 FAL_AI_KEY loaded (${FAL_KEY.length} chars)`);
  }
  console.log(`📁 Images saved to: ${OUTPUT_DIR}\n`);
});
