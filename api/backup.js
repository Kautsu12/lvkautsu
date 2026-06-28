// api/backup.js — Backup completo do SGI (Upstash Redis).
//  • GET  ?download=1   (ADM logado)            -> baixa JSON com TODAS as chaves
//  • POST ?restore=1    (ADM logado)            -> restaura as chaves do JSON enviado
//  • GET  (Vercel Cron / ?secret=CRON_SECRET)   -> gera backup e envia por e-mail (anexo)
const { Redis } = require('@upstash/redis');
const { sendMail, gmailConfigured } = require('../lib/gmail');
const { getSession } = require('../lib/session');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim().replace(/^["']|["']$/g, '');
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');
const CRON_SECRET   = process.env.CRON_SECRET || '';
const BACKUP_EMAIL  = (process.env.BACKUP_EMAIL || process.env.GMAIL_USER || '').trim();
let SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
try { if (SUPABASE_URL) SUPABASE_URL = new URL(SUPABASE_URL).origin; } catch (e) {}
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = process.env.SUPABASE_BUCKET || 'terceiros-docs';
const SBH = { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY };
async function sbList(prefix) {
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
    method: 'POST', headers: { ...SBH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: prefix || '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!r.ok) return [];
  return r.json();
}
async function listAllFiles(prefix) {
  const items = await sbList(prefix || '');
  let out = [];
  for (const it of items) {
    const full = prefix ? (prefix + '/' + it.name) : it.name;
    if (it.id === null || it.id === undefined) { out = out.concat(await listAllFiles(full)); }
    else { out.push(full); }
  }
  return out;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(function (c) {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
}
// Identidade/papel vêm da SESSÃO no servidor (Redis), nunca de cookie editável.
async function getUser(req) {
  const s = await getSession(req);
  return s ? (s.user || 'R') : null;
}
async function roleOf(req) {
  const s = await getSession(req);
  return s ? (s.role || null) : null;
}
function readJson(req) {
  return new Promise(function (resolve) {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = ''; req.on('data', function (c) { d += c; }); req.on('end', function () { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); req.on('error', function () { resolve({}); });
  });
}
async function buildBackup(redis) {
  let keys = [];
  try { keys = await redis.keys('*'); } catch (e) { keys = []; }
  keys = (keys || []).filter(function (k) { return !String(k).startsWith('portal_session:'); });
  const out = {};
  for (const k of keys) { try { out[k] = await redis.get(k); } catch (e) { out[k] = null; } }
  return { exportedAt: new Date().toISOString(), version: 2, count: keys.length, keys: out };
}
async function stampLast(redis, bk, via) {
  try { await redis.set('backup_last', JSON.stringify({ at: bk.exportedAt, count: bk.count, via: via })); } catch (e) {}
}

module.exports = async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ ok: false, error: 'Redis não configurado' });
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  const q = req.query || {};

  // SEGURANCA: confia APENAS no segredo do cron (Authorization: Bearer CRON_SECRET).
  // O antigo teste por User-Agent 'vercel-cron' era forjavel e permitia baixar TODO o banco sem login.
  const isVercelCron = !!CRON_SECRET && (req.headers.authorization || '') === 'Bearer ' + CRON_SECRET;
  const isSecret = CRON_SECRET && q.secret === CRON_SECRET;

  // ── CRON / secret ──
  if (isVercelCron || isSecret) {
    // ARQUIVOS do Supabase (para o Apps Script copiar ao Drive)
    if (req.query && req.query.files === 'list') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).json({ ok: false, error: 'Supabase nao configurado' });
      const files = await listAllFiles('');
      return res.status(200).json({ ok: true, count: files.length, files: files });
    }
    if (req.query && req.query.file) {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).json({ ok: false, error: 'Supabase nao configurado' });
      const safeFile = String(req.query.file);
      // Bloqueia path traversal e caminhos absolutos.
      if (safeFile.includes('..') || safeFile.startsWith('/') || safeFile.includes('\\')) {
        return res.status(400).json({ ok: false, error: 'Nome de arquivo inválido' });
      }
      const fr = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURI(safeFile), { headers: SBH });
      if (!fr.ok) return res.status(fr.status).json({ ok: false, error: 'Falha ao buscar arquivo (' + fr.status + ')' });
      const ab = await fr.arrayBuffer();
      res.statusCode = 200;
      res.setHeader('Content-Type', fr.headers.get('content-type') || 'application/octet-stream');
      return res.end(Buffer.from(ab));
    }
    const bk = await buildBackup(redis);
    const json = JSON.stringify(bk);
    const fname = 'backup_sgi_' + new Date().toISOString().slice(0, 10) + '.json';
    // modo "puxar": retorna o JSON (Apps Script/Power Automate salvam no Drive/OneDrive/SharePoint)
    if (req.query && (req.query.raw || req.query.json)) {
      await stampLast(redis, bk, 'drive/pull');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
      return res.end(json);
    }
    // senão, envia por e-mail (cron diário)
    if (!gmailConfigured()) return res.status(200).json({ ok: false, error: 'Gmail não configurado (GMAIL_USER/GMAIL_APP_PASSWORD)' });
    if (!BACKUP_EMAIL) return res.status(200).json({ ok: false, error: 'BACKUP_EMAIL/GMAIL_USER não definido' });
    try {
      await sendMail({
        to: BACKUP_EMAIL,
        subject: 'Backup Central SGI — ' + new Date().toLocaleDateString('pt-BR'),
        html: '<div style="font-family:sans-serif"><h2 style="color:#0d2137">Backup automático — Central SGI</h2><p>Em anexo, o backup completo dos dados do sistema.</p><p style="color:#64748b;font-size:13px">' + bk.count + ' chaves · ' + Math.round(json.length / 1024) + ' KB · gerado em ' + bk.exportedAt + '</p><p style="color:#94a3b8;font-size:12px">Guarde este arquivo. Para restaurar, use Configurações &gt; Backup e Restauração.</p></div>',
        attachments: [{ filename: fname, content: json, contentType: 'application/json' }],
      });
      await stampLast(redis, bk, 'e-mail');
      return res.status(200).json({ ok: true, count: bk.count, email: BACKUP_EMAIL });
    } catch (e) { return res.status(200).json({ ok: false, error: e.message || String(e) }); }
  }

  // ── Usuário logado ──
  if (!(await getUser(req))) return res.status(401).json({ ok: false, error: 'Não autenticado' });

  // saúde do backup (qualquer logado)
  if (req.method === 'GET' && q.status) {
    let last = null;
    try { const r = await redis.get('backup_last'); last = typeof r === 'string' ? JSON.parse(r) : r; } catch (e) {}
    return res.status(200).json({ ok: true, last: last });
  }

  // daqui pra baixo: só ADM
  const role = await roleOf(req);
  if (role !== 'ADM') return res.status(403).json({ ok: false, error: 'Apenas o administrador (ADM) pode exportar/restaurar backups.' });

  if (req.method === 'GET' && q.download) {
    const bk = await buildBackup(redis);
    await stampLast(redis, bk, 'download');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="backup_sgi_' + new Date().toISOString().slice(0, 10) + '.json"');
    return res.end(JSON.stringify(bk));
  }
  if (req.method === 'POST' && q.restore) {
    const body = await readJson(req);
    const keys = (body && body.keys && typeof body.keys === 'object') ? body.keys : null;
    if (!keys) return res.status(400).json({ ok: false, error: 'Arquivo de backup inválido (sem "keys").' });
    let n = 0;
    for (const k of Object.keys(keys)) {
      if (String(k).startsWith('portal_session:')) continue;
      const v = keys[k]; if (v === null || v === undefined) continue;
      try { await redis.set(k, typeof v === 'string' ? v : JSON.stringify(v)); n++; } catch (e) {}
    }
    return res.status(200).json({ ok: true, restored: n });
  }
  return res.status(400).json({ ok: false, error: 'Ação inválida' });
};
