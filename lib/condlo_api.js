// lib/condlo_api.js — handler HTTP das Condicionantes da LO.
// NAO fica em /api por causa do limite de 12 funcoes do plano Hobby da Vercel:
// e' servido por /api/terc?condlo_api=1, com o rewrite "/api/condlo" -> "/api/terc?condlo_api=1"
// no vercel.json (as URLs publicas /api/condlo continuam funcionando).
// Rotas:
//   GET  ?cumprir=1&id=&token=          -> dados p/ página pública de cumprimento (token)
//   POST ?cumprir=1&id=&token=          -> registra cumprimento (JSON ou multipart c/ anexo)
//   GET                                  -> estado completo (sessão)
//   POST {licencas, conds}               -> salva tudo (sessão ADM/SGI/Gestor)
//   GET  ?file=<path>                    -> URL assinada da evidência anexada (sessão)
//   POST ?check=1                        -> dispara verificação manual (sessão ADM/SGI)
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const { getSession } = require('./session');
const { checkCondLo, nextDate, STORE_KEY } = require('./condlo');
const { sendMail, gmailConfigured } = require('./gmail');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim().replace(/^["']|["']$/g, '');
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');
let SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
try { if (SUPABASE_URL) SUPABASE_URL = new URL(SUPABASE_URL).origin; } catch (e) {}
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = 'terceiros-docs';
const BASE_URL = 'https://' + (process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'project-l4zew.vercel.app').replace(/^https?:\/\//, '').replace(/\/+$/, '');

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
async function readStore(redis) {
  let st = null;
  try { const raw = await redis.get(STORE_KEY); st = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { st = null; }
  if (!st || typeof st !== 'object') st = {};
  if (!Array.isArray(st.licencas)) st.licencas = [];
  if (!Array.isArray(st.conds)) st.conds = [];
  return st;
}
function pubCond(c, lic) {
  return {
    id: c.id, num: c.num || '', descricao: c.descricao || '', frequencia: c.frequencia || '',
    proximoPrazo: c.proximoPrazo || null, responsavel: c.responsavel || '',
    pastaPadrao: c.pastaPadrao || '', atendida: !!c.atendida,
    licenca: lic ? { numero: lic.numero || '', orgao: lic.orgao || '', unidade: lic.unidade || '' } : null,
  };
}

module.exports = async function condloHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis não configurado' });
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

  // ══ fluxo público: registrar cumprimento por token ══
  if (req.query && req.query.cumprir) {
    const id = String(req.query.id || '');
    const token = String(req.query.token || '');
    if (!id || !token) return res.status(400).json({ error: 'Faltam id/token' });
    const st = await readStore(redis);
    const ci = st.conds.findIndex(function (c) { return c.id === id; });
    if (ci < 0) return res.status(404).json({ error: 'Condicionante não encontrada' });
    const cond = st.conds[ci];
    if (!cond.token || cond.token !== token) return res.status(403).json({ error: 'Link inválido ou expirado.' });
    const lic = st.licencas.find(function (l) { return l.id === cond.licencaId; }) || null;

    if (req.method === 'GET') return res.status(200).json({ ok: true, cond: pubCond(cond, lic) });

    if (req.method === 'POST') {
      let campos = {}, filePart = null;
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('multipart/form-data')) {
        const bm = ct.match(/boundary=(.+)/);
        const parts = bm ? parseMultipart(await readRaw(req), bm[1].trim().replace(/^"|"$/g, '')) : [];
        parts.forEach(function (p) {
          if (p.filename && p.name === 'file') filePart = p;
          else if (p.name) campos[p.name] = p.data.toString('utf8');
        });
      } else {
        campos = await readJson(req);
      }
      const dataCum = String(campos.data || '').slice(0, 10);
      const protocolo = String(campos.protocolo || '').trim().slice(0, 120);
      const obs = String(campos.obs || '').trim().slice(0, 500);
      const evTipo = String(campos.evTipo || '').trim(); // anexo | link | pasta
      const evLink = String(campos.evLink || '').trim().slice(0, 500);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataCum)) return res.status(400).json({ error: 'Data do cumprimento inválida.' });
      if (!protocolo) return res.status(400).json({ error: 'Informe o nº do protocolo/recibo.' });

      let ev = null;
      if (evTipo === 'anexo') {
        if (!filePart) return res.status(400).json({ error: 'Anexe o comprovante.' });
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Storage não configurado' });
        if (filePart.data.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo acima de 15 MB.' });
        const safe = sanit(filePart.filename, 'comprovante');
        const fpath = `condlo/${cond.id}/${Date.now()}_${safe}`;
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${fpath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': filePart.contentType || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': '3600' }, body: filePart.data });
        if (!up.ok) { const t = await up.text().catch(function () { return ''; }); return res.status(500).json({ error: `Falha no upload (${up.status}): ${t.slice(0, 120)}` }); }
        ev = { tipo: 'anexo', valor: fpath, nome: filePart.filename };
      } else if (evTipo === 'link') {
        if (!/^https?:\/\//i.test(evLink)) return res.status(400).json({ error: 'Link da evidência inválido.' });
        ev = { tipo: 'link', valor: evLink };
      } else if (evTipo === 'pasta') {
        if (!cond.pastaPadrao) return res.status(400).json({ error: 'Esta condicionante não tem pasta padrão cadastrada.' });
        ev = { tipo: 'pasta', valor: cond.pastaPadrao };
      } else {
        return res.status(400).json({ error: 'Escolha a forma da evidência.' });
      }

      cond.historico = Array.isArray(cond.historico) ? cond.historico : [];
      cond.historico.unshift({ data: dataCum, protocolo: protocolo, evidencia: ev, obs: obs, em: new Date().toISOString(), por: 'link-publico' });
      cond.notifiedDays = [];
      const prox = nextDate(dataCum, cond.frequencia);
      const freq = String(cond.frequencia || '').toLowerCase();
      if (freq === 'unica') { cond.atendida = true; cond.proximoPrazo = null; }
      else if (prox) { cond.proximoPrazo = prox; }
      else { cond.proximoPrazo = null; } // contínua: sem próximo prazo automático
      cond.token = crypto.randomBytes(16).toString('hex'); // link usado 1x
      cond.updatedAt = new Date().toISOString();
      st.conds[ci] = cond;
      try { await redis.set(STORE_KEY, JSON.stringify(st)); } catch (e) { return res.status(500).json({ error: 'Erro ao salvar: ' + e.message }); }
      return res.status(200).json({ ok: true, proximoPrazo: cond.proximoPrazo, atendida: !!cond.atendida });
    }
    return res.status(405).json({ error: 'Método não suportado' });
  }

  // ══ demais rotas: exigem sessão ══
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  const role = sess.role || '';
  const canEdit = (role === 'ADM' || role === 'SGI' || role === 'Gestor');

  if (req.method === 'GET' && req.query && req.query.file) {
    const fpath = String(req.query.file);
    if (!/^condlo\//.test(fpath)) return res.status(400).json({ error: 'Caminho inválido' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Storage não configurado' });
    const sg = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${fpath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
    if (!sg.ok) return res.status(500).json({ error: 'Falha ao gerar link' });
    const sj = await sg.json();
    const signed = sj.signedURL || sj.signedUrl || '';
    return res.status(200).json({ ok: true, url: signed ? `${SUPABASE_URL}/storage/v1${signed}` : '' });
  }

  if (req.method === 'POST' && req.query && req.query.check) {
    if (role !== 'ADM' && role !== 'SGI') return res.status(403).json({ error: 'Sem permissão' });
    const out = await checkCondLo(redis, { sendMail, gmailConfigured }, BASE_URL);
    return res.status(200).json(out);
  }

  if (req.method === 'GET') {
    const st = await readStore(redis);
    return res.status(200).json({ ok: true, licencas: st.licencas, conds: st.conds, me: { role: role, canEdit: canEdit } });
  }

  if (req.method === 'POST') {
    if (!canEdit) return res.status(403).json({ error: 'Sem permissão para editar' });
    const body = await readJson(req);
    if (!body || !Array.isArray(body.licencas) || !Array.isArray(body.conds)) return res.status(400).json({ error: 'Formato inválido' });
    const cur = await readStore(redis);
    const curCond = {}; cur.conds.forEach(function (c) { curCond[c.id] = c; });
    const licencas = body.licencas.slice(0, 50).map(function (l) {
      return {
        id: String(l.id || ('lic_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))),
        numero: String(l.numero || '').slice(0, 80), orgao: String(l.orgao || '').slice(0, 80),
        unidade: String(l.unidade || '').toUpperCase().slice(0, 40), atividade: String(l.atividade || '').slice(0, 160),
        processo: String(l.processo || '').slice(0, 80), emissao: String(l.emissao || '').slice(0, 10),
        validade: String(l.validade || '').slice(0, 10), arquivo: String(l.arquivo || '').slice(0, 500),
        renovacaoPedida: (l.renovacaoPedida && l.renovacaoPedida.data) ? { data: String(l.renovacaoPedida.data).slice(0, 10), protocolo: String(l.renovacaoPedida.protocolo || '').slice(0, 120) } : null,
        notifiedRenew: (cur.licencas.find(function (x) { return x.id === l.id; }) || {}).notifiedRenew || [],
      };
    });
    const conds = body.conds.slice(0, 500).map(function (c) {
      const old = curCond[c.id] || {};
      return {
        id: String(c.id || ('cond_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))),
        licencaId: String(c.licencaId || ''), num: String(c.num || '').slice(0, 20),
        descricao: String(c.descricao || '').slice(0, 400), frequencia: String(c.frequencia || 'unica').toLowerCase().slice(0, 20),
        proximoPrazo: c.proximoPrazo ? String(c.proximoPrazo).slice(0, 10) : null,
        responsavel: String(c.responsavel || '').slice(0, 80), responsavelEmail: String(c.responsavelEmail || '').toLowerCase().slice(0, 120),
        pastaPadrao: String(c.pastaPadrao || '').slice(0, 500),
        atendida: !!c.atendida,
        historico: Array.isArray(old.historico) ? old.historico : [],
        notifiedDays: (old.proximoPrazo === (c.proximoPrazo || null)) ? (old.notifiedDays || []) : [],
        token: old.token || crypto.randomBytes(16).toString('hex'),
        updatedAt: new Date().toISOString(),
      };
    });
    // registro de cumprimento vindo do painel (interno)
    if (body.cumprimento && body.cumprimento.condId) {
      const cp = body.cumprimento;
      const ci = conds.findIndex(function (c) { return c.id === cp.condId; });
      if (ci >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(cp.data || '')) && String(cp.protocolo || '').trim()) {
        const cond = conds[ci];
        let ev = null;
        if (cp.evTipo === 'link' && /^https?:\/\//i.test(String(cp.evLink || ''))) ev = { tipo: 'link', valor: String(cp.evLink).slice(0, 500) };
        else if (cp.evTipo === 'pasta' && cond.pastaPadrao) ev = { tipo: 'pasta', valor: cond.pastaPadrao };
        if (ev) {
          cond.historico.unshift({ data: String(cp.data).slice(0, 10), protocolo: String(cp.protocolo).trim().slice(0, 120), evidencia: ev, obs: String(cp.obs || '').slice(0, 500), em: new Date().toISOString(), por: sess.email || sess.user || 'painel' });
          cond.notifiedDays = [];
          const prox = nextDate(cp.data, cond.frequencia);
          if (cond.frequencia === 'unica') { cond.atendida = true; cond.proximoPrazo = null; }
          else if (prox) cond.proximoPrazo = prox;
          else cond.proximoPrazo = null;
        }
      }
    }
    try { await redis.set(STORE_KEY, JSON.stringify({ licencas: licencas, conds: conds })); } catch (e) { return res.status(500).json({ error: 'Erro ao salvar: ' + e.message }); }
    return res.status(200).json({ ok: true, licencas: licencas.length, conds: conds.length });
  }

  return res.status(405).json({ error: 'Método não suportado' });
};
