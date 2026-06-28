// api/renew_document.js — renovação de documento via link público (com token).
// Renovar EXIGE anexar o arquivo atualizado (multipart). A data nova também é obrigatória.
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || "").trim().replace(/^["']|["']$/g, "");
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim().replace(/^["']|["']$/g, "");
let SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
try { if (SUPABASE_URL) SUPABASE_URL = new URL(SUPABASE_URL).origin; } catch (e) {}
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = 'terceiros-docs';

function sanit(name, fallback) {
  let n = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return n && n !== '_' ? n : (fallback || 'arquivo');
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
  const parts = []; let pos = 0;
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
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (req.body && typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); } }
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function emailFromReq(req){
  const ch = req.headers.cookie || '';
  const part = ch.split(';').map(function(c){return c.trim();}).find(function(c){return c.indexOf('raitz_email=')===0;});
  if(!part) return '';
  try { return decodeURIComponent(part.split('=').slice(1).join('=')).toLowerCase(); } catch(_){ return ''; }
}
async function roleOfReq(req, redis){
  const email = emailFromReq(req);
  if(!email) return null;
  try{ const raw = await redis.get('sgi_users'); const u=(typeof raw==='string'?JSON.parse(raw):raw)||{}; const rec=u[email]; return rec?rec.role:null; }catch(e){ return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis não configurado' });
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

  // ── RNC (Relatório de Não Conformidade) — edição pública por token ──
  if (req.query && req.query.kind === 'rnc') {
    const rid = (req.query.id || '').toString();
    const rtoken = (req.query.token || '').toString();
    if (!rid || !rtoken) return res.status(400).json({ error: 'Faltam id/token' });
    let recs = [];
    try { const raw = await redis.get('rnc_records'); recs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []); }
    catch (e) { return res.status(500).json({ error: 'Erro ao ler RNCs' }); }
    const ri = recs.findIndex(x => x.id === rid);
    if (ri < 0) return res.status(404).json({ error: 'RNC não encontrada' });
    const rec = recs[ri];
    if (!rec.token || rec.token !== rtoken) return res.status(403).json({ error: 'Link inválido ou expirado.' });
    if (req.method === 'GET' && req.query.download) {
      try {
        const isPlano = String(req.query.download) === 'plano';
        const { buildRncXlsx, buildPlanoXlsx } = require('../lib/rnc_excel');
        const buf = isPlano ? await buildPlanoXlsx(rec) : await buildRncXlsx(rec);
        const fname = (isPlano ? 'Plano_de_Acao_' : 'RNC_') + String(rec.num || 'documento').replace(/[^A-Za-z0-9_-]/g, '_') + '.xlsx';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
        res.statusCode = 200;
        return res.end(buf);
      } catch (e) { return res.status(500).json({ error: 'Falha ao gerar Excel: ' + (e.message || String(e)) }); }
    }
    if (req.method === 'GET' && req.query.fileview) {
      const fpath = String(req.query.fileview);
      const ev = (rec.evidencias || []).find(function (e) { return e.path === fpath; });
      if (!ev) return res.status(404).json({ error: 'Evidência não encontrada' });
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Storage não configurado' });
      const sg = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${fpath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
      if (!sg.ok) return res.status(500).json({ error: 'Falha ao gerar link' });
      const sj = await sg.json();
      const signed = sj.signedURL || sj.signedUrl || '';
      return res.status(200).json({ ok: true, url: signed ? `${SUPABASE_URL}/storage/v1${signed}` : '' });
    }
    if (req.method === 'GET') return res.status(200).json({ ok: true, rnc: rec });
    if (req.method === 'POST' && (req.headers['content-type'] || '').toLowerCase().includes('multipart/form-data')) {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Storage não configurado' });
      const ctU = (req.headers['content-type'] || '').toLowerCase();
      const bmU = ctU.match(/boundary=(.+)/);
      const partsU = bmU ? parseMultipart(await readRaw(req), bmU[1].trim().replace(/^"|"$/g, '')) : [];
      const fp = partsU.find(function (x) { return x.filename && x.name === 'file'; });
      const quemP = partsU.find(function (x) { return x.name === 'quem'; });
      if (!fp || !fp.filename) return res.status(400).json({ error: 'Arquivo não encontrado' });
      const safe = sanit(fp.filename, 'evidencia');
      const fpath = `rnc/${rid}/${Date.now()}_${safe}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${fpath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': fp.contentType || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': '3600' }, body: fp.data });
      if (!up.ok) { const t = await up.text().catch(function () { return ''; }); return res.status(500).json({ error: `Falha no upload (${up.status}): ${t.slice(0, 150)}` }); }
      const quem = (quemP ? quemP.data.toString() : 'setor').slice(0, 80);
      rec.evidencias = Array.isArray(rec.evidencias) ? rec.evidencias : [];
      rec.evidencias.push({ path: fpath, fileName: fp.filename, at: new Date().toISOString(), by: quem });
      rec.history = Array.isArray(rec.history) ? rec.history : [];
      rec.history.push({ at: new Date().toISOString(), by: quem, changed: ['evidência anexada'] });
      rec.updatedAt = new Date().toISOString();
      recs[ri] = rec;
      try { await redis.set('rnc_records', JSON.stringify(recs)); } catch (e) { return res.status(500).json({ error: 'Erro ao salvar: ' + e.message }); }
      return res.status(200).json({ ok: true, evidencias: rec.evidencias });
    }
    if (req.method === 'POST') {
      const b = await readJson(req);
      if (b && b.removeEvidencia) {
        rec.evidencias = (Array.isArray(rec.evidencias) ? rec.evidencias : []).filter(function (e) { return e.path !== b.removeEvidencia; });
        rec.updatedAt = new Date().toISOString();
        recs[ri] = rec;
        try { await redis.set('rnc_records', JSON.stringify(recs)); } catch (e) { return res.status(500).json({ error: 'Erro ao salvar: ' + e.message }); }
        return res.status(200).json({ ok: true, evidencias: rec.evidencias });
      }
      const _role = await roleOfReq(req, redis);
      const _canEfic = (_role === 'ADM' || _role === 'SGI');
      // Somente ADM/SGI podem CONCLUIR a RNC. Outros nao conseguem definir status 'concluida'.
      if (b.status === 'concluida' && !_canEfic) { b.status = (rec.status === 'concluida') ? 'concluida' : 'em_tratamento'; }
      const editable = ['equipe', 'contencao', 'contencaoResp', 'contencaoPrazo', 'causaRaiz', 'acoesCorrecao', 'implementacao', 'preventivas', 'tratativa', 'status'];
      if (_canEfic) editable.push('eficacia');
      const changed = [];
      editable.forEach(function (k) {
        if (b[k] !== undefined && JSON.stringify(b[k]) !== JSON.stringify(rec[k])) { rec[k] = b[k]; changed.push(k); }
      });
      rec.history = Array.isArray(rec.history) ? rec.history : [];
      rec.history.push({ at: new Date().toISOString(), by: (b.quem || 'setor').toString().slice(0, 80), changed: changed });
      rec.updatedAt = new Date().toISOString();
      if (rec.status === 'emitida' && changed.length) rec.status = 'em_tratamento';
      recs[ri] = rec;
      try { await redis.set('rnc_records', JSON.stringify(recs)); } catch (e) { return res.status(500).json({ error: 'Erro ao salvar: ' + e.message }); }
      return res.status(200).json({ ok: true, status: rec.status });
    }
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const ct = (req.headers['content-type'] || '').toLowerCase();
  const isMultipart = ct.includes('multipart/form-data');

  let fields = {}, filePart = null;
  if (req.method === 'POST' && isMultipart) {
    const rawBody = await readRaw(req);
    const bm = ct.match(/boundary=(.+)/);
    if (bm) {
      const parts = parseMultipart(rawBody, bm[1].trim().replace(/^"|"$/g, ''));
      parts.forEach(function (p) {
        if (p.filename && p.name === 'file') filePart = p;
        else if (p.name) fields[p.name] = p.data.toString();
      });
    }
  }

  const docId = (req.query && req.query.docId) || fields.docId || (req.body && req.body.docId) || '';
  const token = (req.query && req.query.token) || fields.token || (req.body && req.body.token) || '';
  if (!docId || !token) return res.status(400).json({ error: 'Faltam docId/token' });

  let docs = [];
  try {
    const raw = await redis.get('documentos_vencimento');
    docs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
  } catch (e) { return res.status(500).json({ error: 'Erro ao ler docs' }); }

  const idx = docs.findIndex(d => d.id === docId);
  if (idx < 0) return res.status(404).json({ error: 'Documento não encontrado' });
  const doc = docs[idx];
  if (!doc.renewalToken || doc.renewalToken !== token) return res.status(403).json({ error: 'Token inválido ou expirado. Solicite novo envio do email.' });

  if (req.method === 'GET') {
    return res.status(200).json({
      doc: {
        id: doc.id, nome: doc.nome, tipo: doc.tipo, responsavel: doc.responsavel, cargo: doc.cargo || '',
        unidade: doc.unidade || '', dataVencimento: doc.dataVencimento,
        pasta: doc.pasta || '', fileName: doc.fileName || '', hasFile: !!doc.filePath
      }
    });
  }

  if (req.method === 'POST') {
    const novaData = isMultipart ? fields.novaData : (await readJson(req)).novaData;
    const novaPasta = isMultipart ? (fields.novaPasta || '') : '';
    const quem = isMultipart ? (fields.quem || '').toString().slice(0, 80) : '';
    if (!novaData || !/^\d{4}-\d{2}-\d{2}$/.test(novaData)) return res.status(400).json({ error: 'Data inválida (use AAAA-MM-DD)' });

    // Arquivo é OBRIGATÓRIO na renovação
    if (!filePart || !filePart.filename) return res.status(400).json({ error: 'É obrigatório anexar o arquivo atualizado para renovar.' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Armazenamento não configurado (Supabase).' });

    const safeName = sanit(filePart.filename, 'documento');
    const path = `docint/${Date.now()}_${safeName}`;
    try {
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': filePart.contentType || 'application/octet-stream',
          'x-upsert': 'false', 'cache-control': '3600',
        },
        body: filePart.data,
      });
      if (!up.ok) { const t = await up.text().catch(() => ''); return res.status(500).json({ error: `Falha ao enviar arquivo (${up.status}): ${t.slice(0, 160)}` }); }
    } catch (e) { return res.status(500).json({ error: 'Falha no upload: ' + e.message }); }

    doc.dataVencimento = novaData;
    doc.status = 'ativo';
    doc.notifiedDays = [];
    doc.filePath = path;
    doc.fileName = filePart.filename;
    if (novaPasta) doc.pasta = novaPasta;
    doc.lastRenewedAt = new Date().toISOString();
    doc.lastRenewedBy = quem || 'via email';
    doc.renewalToken = crypto.randomBytes(16).toString('hex');
    doc.updatedAt = new Date().toISOString();
    docs[idx] = doc;

    try { await redis.set('documentos_vencimento', JSON.stringify(docs)); }
    catch (e) { return res.status(500).json({ error: 'Erro ao salvar: ' + e.message }); }
    return res.status(200).json({ ok: true, doc: { id: doc.id, dataVencimento: doc.dataVencimento, fileName: doc.fileName } });
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
