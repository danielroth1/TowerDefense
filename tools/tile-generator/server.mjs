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

// Known pricing for fal.ai text-to-image models (per megapixel or per image).
// Sources: official fal.ai pricing page, individual model pages, and docs.
// Models not listed here use GPU-based (per-second) pricing or vary.
const MODEL_PRICING = {
  'fal-ai/fast-sdxl':                     { cost: 'GPU per-sec', unit: '', note: 'GPU-based pricing' },
  'fal-ai/flux/schnell':                  { cost: '$0.003',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-1/schnell':                { cost: '$0.003',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux/dev':                      { cost: '$0.025',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-lora':                     { cost: '$0.025',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-pro/v1.1':                 { cost: '$0.045',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-pro/v1.1-ultra':           { cost: '$0.065',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-pro/kontext/text-to-image':{ cost: '$0.040',     unit: '/img', note: 'per image' },
  'fal-ai/flux-2':                        { cost: '$0.030',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2/turbo':                  { cost: '$0.015',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2/flash':                  { cost: '$0.005',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2/klein/9b':               { cost: '$0.015',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2-pro':                    { cost: '$0.050',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2-max':                    { cost: '$0.080',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2-flex':                   { cost: '$0.020',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/nano-banana':                   { cost: '$0.005',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/nano-banana-2':                 { cost: '$0.005',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/nano-banana-pro':               { cost: '$0.040',     unit: '/img', note: 'per image' },
  'fal-ai/gemini-25-flash-image':         { cost: '$0.002',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/gemini-3-pro-image-preview':    { cost: '$0.005',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/gemini-3.1-flash-image-preview':{ cost: '$0.003',     unit: '/MP', note: 'per megapixel' },
  'openai/gpt-image-2':                   { cost: '$0.040',     unit: '/img', note: 'per image (1MP)' },
  'fal-ai/gpt-image-1.5':                 { cost: '$0.030',     unit: '/img', note: 'per image (1MP)' },
  'fal-ai/gpt-image-1/text-to-image':     { cost: '$0.020',     unit: '/img', note: 'per image (1MP)' },
  'xai/grok-imagine-image':               { cost: '$0.003',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/bytedance/seedream/v4/text-to-image':   { cost: '$0.030', unit: '/img', note: 'per image (1MP)' },
  'fal-ai/bytedance/seedream/v4.5/text-to-image': { cost: '$0.030', unit: '/img', note: 'per image (1MP)' },
  'fal-ai/bytedance/seedream/v5/lite/text-to-image':{ cost:'$0.020', unit:'/img', note:'per image (1MP)' },
  'fal-ai/ideogram/v3':                   { cost: '$0.003',     unit: '/MP', note: 'per megapixel' },
  'ideogram/v4':                          { cost: '$0.004',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/recraft/v3/text-to-image':      { cost: '$0.004',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/recraft/v4/text-to-image':      { cost: '$0.006',     unit: '/MP', note: 'per megapixel' },
  'krea/v2/large/text-to-image':          { cost: '$0.004',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/z-image/turbo':                 { cost: '$0.002',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/z-image/turbo/lora':            { cost: '$0.002',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/qwen-image':                    { cost: '$0.020',     unit: '/MP', note: 'per megapixel' },
  'fal-ai/flux-2/lora':                   { cost: '$0.030',     unit: '/MP', note: 'per megapixel' },
};

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
      const resp = await fetch('https://api.fal.ai/v1/models?limit=200', {
        headers: { 'Authorization': `Key ${FAL_KEY}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} from fal.ai`);
      const data = await resp.json();
      const t2i = (data.models || [])
        .filter(m => m.metadata?.category === 'text-to-image' && m.metadata?.status === 'active')
        .map(m => {
          const eid = m.endpoint_id;
          const price = MODEL_PRICING[eid] || { cost: '—', unit: '', note: '' };
          // Shorten display name: remove "Text To Image", "API" suffix
          let dn = m.metadata.display_name
            .replace(/ Text To Image$/, '')
            .replace(/ API$/, '');
          return {
            id: eid,
            name: dn,
            description: (m.metadata.description || '').split('\n')[0].slice(0, 200),
            pricing: price,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, { models: t2i });
    } catch (err) {
      console.error('[models] Error:', err);
      return json(res, { error: String(err) }, 500);
    }
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
      num_inference_steps: falModel.includes('schnell') ? 4 : 28,
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
