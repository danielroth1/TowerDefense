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
