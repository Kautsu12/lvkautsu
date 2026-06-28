// api/portal-upload.js — upload de evidência pelo fornecedor (portal)
// Auth: sessão portal (cookie portal_session). Escopo travado ao terceiroId da sessão.
// Armazena no Supabase Storage (bucket privado 'terceiros-docs') via REST (sem supabase-js).
// Retorna { ok, path, fileName }
const { Redis } = require('@upstash/redis');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
let   SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
try { if (SUPABASE_URL) SUPABASE_URL = new URL(SUPABASE_URL).origin; } catch (e) {}
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = 'terceiros-docs';

function getRedis() { return new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }
function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), v.join('=')];
    })
  );
}
async function getPortalSession(req, redis) {
  const token = parseCookies(req)['portal_session'];
  if (!token) return null;
  return await redis.get(`portal_session:${token}`);
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseMultipart(body, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = 0;
  while (pos < body.length) {
    const nextSep = body.indexOf(sep, pos);
    if (nextSep === -1) break;
    pos = nextSep + sep.length;
    if (body.slice(pos, pos + 2).toString() === '--') break;
    pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headerStr = body.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;
    const nextBoundary = body.indexOf(sep, pos);
    const contentEnd = nextBoundary === -1 ? body.length : nextBoundary - 2;
    const content = body.slice(pos, contentEnd);
    pos = nextBoundary !== -1 ? nextBoundary : body.length;
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const fileMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch   = headerStr.match(/Content-Type:\s*(.+)/i);
    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: fileMatch ? fileMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      data: content,
    });
  }
  return parts;
}
const sanit = (s, fb) => (String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || fb);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
    return res.status(500).json({ ok: false, error: 'Supabase não configurado' });

  const redis = getRedis();
  const session = await getPortalSession(req, redis);
  if (!session) return res.status(401).json({ ok: false, error: 'Não autenticado' });
  const terceiroId = sanit(session.terceiroId, 'sem_terceiro');

  const ct = req.headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=(.+)/);
  if (!boundaryMatch) return res.status(400).json({ ok: false, error: 'Content-Type inválido' });

  const parts = parseMultipart(await readRaw(req), boundaryMatch[1].trim().replace(/^"|"$/g, ''));
  const filePart = parts.find(p => p.name === 'file');
  const keyPart  = parts.find(p => p.name === 'docKey');
  if (!filePart || !filePart.filename) return res.status(400).json({ ok: false, error: 'Arquivo não encontrado' });

  const docKey   = sanit(keyPart ? keyPart.data.toString().trim() : '', 'doc');
  const safeName = sanit(filePart.filename, 'arquivo');
  const path     = `${terceiroId}/${docKey}_${Date.now()}_${safeName}`;

  try {
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': filePart.contentType || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: filePart.data,
    });
    if (!up.ok) {
      const txt = await up.text().catch(() => '');
      return res.status(500).json({ ok: false, error: `Falha no upload (${up.status}): ${txt.slice(0, 200)}` });
    }
    return res.status(200).json({ ok: true, path, fileName: filePart.filename });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
