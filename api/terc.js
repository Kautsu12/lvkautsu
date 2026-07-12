// api/terc.js — endpoint único da nova Gestão de Terceiros (SGI interno)
//   GET                          -> carrega o estado (Redis key 'terceiros_sgi')
//   POST application/json        -> salva o estado
//   POST multipart/form-data     -> upload de evidência p/ Supabase Storage (campos: file, terceiroId, docKey)
// Auth: sessão interna (cookie raitz_session, usuário J/R). Chave Redis dedicada (não toca a base legada 'terceiros').
// Upload via REST de Storage (fetch) — evita o cliente supabase-js (que falha no Node 20 por WebSocket/Realtime).
const { Redis } = require('@upstash/redis');
const { logEvent } = require('../lib/audit');
const { sendMail, gmailConfigured } = require('../lib/gmail');
const { checkDocint } = require('../lib/docint');
const { getSession } = require('../lib/session');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim().replace(/^["']|["']$/g, '');
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');
let SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
// Usa só a origem (https://<ref>.supabase.co) — evita erro se a var vier com caminho (ex.: /rest/v1)
try { if (SUPABASE_URL) SUPABASE_URL = new URL(SUPABASE_URL).origin; } catch (e) {}
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const STORE_KEY = 'terceiros_sgi';
const BUCKET = 'terceiros-docs';

// Sessao interna server-side (Redis). Retorna 'J'/'R' ou null.
async function getUser(req) {
  const s = await getSession(req);
  return s ? (s.user || 'R') : null;
}
// E-mail CONFIAVEL vindo da sessao no servidor (nao do cookie raitz_email, que era editavel).
// Usado para escopo de acesso (unidade/cargo) — nunca confiar no cookie para isso.
async function sessionEmail(req){
  const s = await getSession(req);
  return s && s.email ? String(s.email).toLowerCase() : '';
}
// Mantido apenas para ATRIBUICAO em logs (best-effort). Nao usar para controle de acesso.
function emailFromReq(req){
  const ch = req.headers.cookie || '';
  const part = ch.split(';').map(function(c){return c.trim();}).find(function(c){return c.indexOf('raitz_email=')===0;});
  if(!part) return '';
  try { return decodeURIComponent(part.split('=').slice(1).join('=')).toLowerCase(); } catch(_){ return ''; }
}
// Escopo por unidade do usuário logado. Retorna array de unidades permitidas, ou null (= todas).
async function scopeUnits(req, redis) {
  const email = await sessionEmail(req);
  const norm = (u) => String(u || '').toUpperCase();
  let role = null, recUnits = [];
  if (email) {
    try {
      const raw = await redis.get('sgi_users');
      const users = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const rec = users && users[email];
      if (rec) { role = rec.role; recUnits = Array.isArray(rec.unidades) ? rec.unidades : (rec.unidade ? [rec.unidade] : []); }
    } catch (e) {}
  }
  if (role === 'Gestor' || role === 'Usuario') {
    return (recUnits && recUnits.length) ? recUnits.map(norm) : null;
  }
  // ADM/SGI: respeita foco via ?unidade=...
  const focus = norm(req.query && req.query.unidade);
  if (['RESENDE','JOINVILLE','CURITIBA'].includes(focus)) return [focus];
  return null;
}
// Escopo de Documentos Internos: combina unidade + cargo. Retorna null (= ADM/SGI vê tudo)
// ou { units:[...], cargo:'cargo em minúsculo ou ''] }.
async function docintScope(req, redis) {
  const email = await sessionEmail(req);
  let role = null, recUnits = [], cargo = '';
  if (email) {
    try {
      const raw = await redis.get('sgi_users');
      const users = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const rec = users && users[email];
      if (rec) {
        role = rec.role;
        recUnits = Array.isArray(rec.unidades) ? rec.unidades : (rec.unidade ? [rec.unidade] : []);
        cargo = String(rec.cargo || '').trim().toLowerCase();
      }
    } catch (e) {}
  }
  if (role === 'ADM' || role === 'SGI') return null;
  return { units: (recUnits || []).map(function (u) { return String(u).toUpperCase(); }), cargo: cargo };
}
function _docintIn(scope, d) {
  if (!scope) return true;
  const u = String((d && d.unidade) || '').toUpperCase();
  const okU = !scope.units.length ? true : scope.units.indexOf(u) !== -1;
  const dc = String((d && d.cargo) || '').trim().toLowerCase();
  const okC = !scope.cargo ? true : (dc === scope.cargo);
  return okU && okC;
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
      name:        nameMatch ? nameMatch[1] : null,
      filename:    fileMatch ? fileMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      data:        content,
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

const sanit = (s, fb) => (String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || fb);

function _esc(x){ return String(x==null?'':x).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
// ── Merge 3-vias de auditoria (item a item) para salvamento simultaneo ──
function _audPickS(b,l,r){ try{ if(JSON.stringify(l)!==JSON.stringify(b===undefined?null:b)) return l; }catch(e){ return l; } return (r!==undefined?r:l); }
function _audMergeMapS(b,l,r){ b=b||{};l=l||{};r=r||{}; var o={},k={}; [b,l,r].forEach(function(x){Object.keys(x).forEach(function(y){k[y]=1;});}); Object.keys(k).forEach(function(y){ o[y]=_audPickS(b[y],l[y],r[y]); }); return o; }
function _audMergeSectorS(b,l,r){ b=b||{};l=l||{};r=r||{}; var o={},k={}; [b,l,r].forEach(function(x){Object.keys(x).forEach(function(y){k[y]=1;});}); Object.keys(k).forEach(function(y){ if(y==='items'){ var bi=b.items||[],li=l.items||[],ri=r.items||[],n=Math.max(bi.length,li.length,ri.length),a=[]; for(var i=0;i<n;i++)a[i]=_audPickS(bi[i],li[i],ri[i]); o.items=a; } else if(y==='_addedItems'){ o._addedItems=_audMergeMapS(b._addedItems,l._addedItems,r._addedItems); } else { o[y]=_audPickS(b[y],l[y],r[y]); } }); return o; }
function audMerge3(base,local,remote){ base=base||{};local=local||{};remote=remote||{}; var o={},k={}; [base,local,remote].forEach(function(x){Object.keys(x).forEach(function(y){k[y]=1;});}); Object.keys(k).forEach(function(y){ if(y==='sectors'){ var b=base.sectors||{},l=local.sectors||{},r=remote.sectors||{},sk={},so={}; [b,l,r].forEach(function(x){Object.keys(x).forEach(function(z){sk[z]=1;});}); Object.keys(sk).forEach(function(z){ so[z]=_audMergeSectorS(b[z],l[z],r[z]); }); o.sectors=so; } else if(y==='home'){ o.home=_audMergeMapS(base.home,local.home,remote.home); } else { o[y]=_audPickS(base[y],local[y],remote[y]); } }); return o; }
function _fmtBR(iso){ if(!iso) return '—'; const p=String(iso).split('-'); return p.length===3?(p[2]+'/'+p[1]+'/'+p[0]):iso; }
function _baseUrl(){ return 'https://'+(process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'project-l4zew.vercel.app').replace(/^https?:\/\//,'').replace(/\/+$/,''); }
async function ccPorAreas(redis, unidade, areas){
  try{
    const raw = await redis.get('area_responsaveis');
    let all = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
    const _U = ['TODAS','RESENDE','JOINVILLE','CURITIBA'];
    const _k = Object.keys(all);
    if (_k.length && _k.every(function(x){ return _U.indexOf(String(x).toUpperCase()) !== -1; })) all = { terceiros: all };
    const mapa = all['terceiros'] || {};
    const U = String(unidade || '').toUpperCase();
    const set = {};
    (areas || []).forEach(function(ar){
      if (!ar) return;
      let m = mapa[U] && mapa[U][ar];
      if (!(Array.isArray(m) && m.length)) m = mapa['TODAS'] && mapa['TODAS'][ar];
      if (Array.isArray(m)) m.forEach(function(e){ if (e) set[String(e).toLowerCase()] = 1; });
    });
    return Object.keys(set);
  } catch(e){ return []; }
}
async function roleOf(req, redis){
  const email = await sessionEmail(req); // identidade confiável da sessão (não cookie)
  if (!email) return null;
  try{ const raw = await redis.get('sgi_users'); const u = typeof raw==='string'?JSON.parse(raw):raw; const rec = u && u[email]; return rec ? rec.role : null; }catch(e){ return null; }
}
function rncEmailHtml(setor, list, base){
  const grauTxt = function(g){ g=String(g||'').toUpperCase(); return g==='A'?'A — Crítica':(g==='B'?'B — Maior':(g==='C'?'C — Oportunidade de melhoria':g||'—')); };
  const cards = list.map(function(r){
    const link = base + '/rnc.html?id=' + encodeURIComponent(r.id) + '&token=' + encodeURIComponent(r.token);
    return '<div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:10px 0">'
      + '<div style="font-size:12px;color:#64748b">RNC ' + _esc(r.num||'') + ' · Grau ' + _esc(grauTxt(r.grau)) + (r.norma?(' · '+_esc(r.norma)):'') + '</div>'
      + '<div style="font-weight:700;color:#0d2137;margin:4px 0">' + _esc(r.clausula||'') + ' — ' + _esc(r.requisito||'') + '</div>'
      + (r.descricao?('<div style="font-size:13px;color:#475569;white-space:pre-wrap;margin-bottom:10px">'+_esc(String(r.descricao).slice(0,400))+'</div>'):'')
      + '<a href="' + link + '" style="display:inline-block;background:#7c2d91;color:#fff;padding:10px 18px;border-radius:7px;text-decoration:none;font-weight:600;font-size:13px">Abrir e tratar a RNC →</a>'
      + '</div>';
  }).join('');
  return '<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto">'
    + '<div style="background:#0d2137;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0"><div style="font-size:14px;font-weight:700">Central SGI</div><div style="font-size:12px;opacity:.7;margin-top:3px">Auditoria Interna — Não conformidade</div></div>'
    + '<div style="border:1px solid #e2e8f0;border-top:0;padding:22px;border-radius:0 0 8px 8px">'
    + '<p style="margin:0 0 6px">Olá! Foram registradas <strong>' + list.length + '</strong> não conformidade(s) para o setor <strong>' + _esc(setor) + '</strong> que precisam de tratamento.</p>'
    + '<p style="font-size:12.5px;color:#64748b;margin:0 0 8px">Clique em cada RNC para preencher a análise de causa e o plano de ação diretamente no sistema. As edições ficam registradas.</p>'
    + cards
    + '<p style="color:#94a3b8;font-size:12px;margin-top:14px">E-mail automático do Central SGI.</p></div></div>';
}
function reprovaHtml(b, base){
  return '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">'
    +'<h2 style="color:#b91c1c">Documento reprovado</h2>'
    +'<p>Olá! Um documento de <strong>'+_esc(b.terceiro||'')+'</strong> foi <strong>reprovado</strong>:</p>'
    +'<p style="font-size:15px"><strong>'+_esc(b.doc||'')+'</strong></p>'
    +(b.motivo?('<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;color:#991b1b"><strong>Motivo:</strong> '+_esc(b.motivo)+'</p>'):'')
    +'<p>Por favor, acesse o portal e reenvie o documento corrigido.</p>'
    +'<a href="'+base+'/portal.html" style="display:inline-block;background:#1a56db;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin:8px 0 20px">Acessar Portal →</a>'
    +'<p style="color:#94a3b8;font-size:12px">E-mail automático do sistema Central SGI.</p></div>';
}
function cobrancaHtml(b, base){
  const itens=(b.itens||[]);
  const rows=itens.map(function(a){
    const cor = a.tipo==='vencido' ? '#dc2626' : '#d97706';
    const sit = a.tipo==='vencido' ? ('Vencido em '+_fmtBR(a.validade))
      : (a.dias!=null ? ('Vence em '+a.dias+' dia'+(a.dias===1?'':'s')+' ('+_fmtBR(a.validade)+')') : 'Pendente');
    return '<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">'+_esc(a.nome)+'</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:'+cor+';font-weight:600">'+sit+'</td></tr>';
  }).join('');
  return '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">'
    +'<h2 style="color:#0d2137">Documentos pendentes / a vencer</h2>'
    +'<p>Olá! Os seguintes documentos de <strong>'+_esc(b.terceiro||'')+'</strong> precisam de atenção:</p>'
    +'<table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e2e8f0">'
    +'<thead><tr style="background:#f8fafc"><th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b">Documento</th><th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b">Situação</th></tr></thead>'
    +'<tbody>'+rows+'</tbody></table>'
    +'<a href="'+base+'/portal.html" style="display:inline-block;background:#1a56db;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin:8px 0 20px">Acessar Portal →</a>'
    +'<p style="color:#94a3b8;font-size:12px">E-mail automático do sistema Central SGI.</p></div>';
}

module.exports = async function handler(req, res) {
  // Condicionantes da LO — consolidado aqui pelo limite de 12 funcoes do plano Hobby.
  // /api/condlo e' reescrito para /api/terc?condlo_api=1 no vercel.json.
  if (req.query && req.query.condlo_api) return require('../lib/condlo_api')(req, res);

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis não configurado' });
  if (!process.env.SESSION_SECRET) return res.status(500).json({ error: 'SESSION_SECRET não definida' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const ct = req.headers['content-type'] || '';

  try {
    const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

    // ── LOAD / SIGN (link temporário) ──
    if (req.method === 'GET') {
      if (req.query && req.query.matrizes) {
        const raw = await redis.get('terceiros_matrizes');
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return res.status(200).json({ ok: true, matrizes: v || null });
      }
      if (req.query && req.query.manuais) {
        const raw = await redis.get('manuais');
        let v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(v) || !v.length) {
          const seeded = await redis.get('manuais_seeded');
          if (!seeded) {
            v = [{ id: 'seed-terceiros', nome: 'Manual de Gestão de Terceiros', revisao: '01', dataRev: '18/06/2026', criador: 'Ayrton Ribeiro', aprovador: '', retencao: 'Permanente (enquanto vigente)', descarte: 'Substituição pela nova revisão', pdfUrl: '/manuais/manual_gestao_terceiros.pdf', criadoEm: new Date().toISOString() }];
            try { await redis.set('manuais', JSON.stringify(v)); await redis.set('manuais_seeded', '1'); } catch (e) {}
          } else { v = []; }
        }
        return res.status(200).json({ ok: true, manuais: Array.isArray(v) ? v : [] });
      }
      if (req.query && req.query.manualpdf) {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ ok: false, error: 'Supabase não configurado' });
        const mpath = String(req.query.manualpdf);
        const rr = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${mpath}`, { headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY } });
        if (!rr.ok) { const tt = await rr.text().catch(() => ''); return res.status(rr.status).json({ ok: false, error: `Falha ao buscar PDF (${rr.status}): ${tt.slice(0,150)}` }); }
        const ab = await rr.arrayBuffer();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'private, max-age=120');
        return res.end(Buffer.from(ab));
      }
      if (req.query && req.query.docint) {
        const raw2 = await redis.get('documentos_vencimento');
        let dlist = Array.isArray(raw2) ? raw2 : (raw2 ? JSON.parse(raw2) : []);
        const scopeD = await docintScope(req, redis);
        if (scopeD) dlist = dlist.filter(function (d) { return _docintIn(scopeD, d); });
        return res.status(200).json({ ok: true, docs: dlist });
      }
      if (req.query && req.query.rnc) {
        const rawR = await redis.get('rnc_records');
        const recs = Array.isArray(rawR) ? rawR : (rawR ? JSON.parse(rawR) : []);
        return res.status(200).json({ ok: true, rncs: recs });
      }
      let fileParam = req.query && req.query.file;
      if (!fileParam) { try { fileParam = new URL(req.url, 'http://x').searchParams.get('file'); } catch (e) {} }
      if (fileParam) {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
          return res.status(500).json({ ok: false, error: 'Supabase não configurado' });
        const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${fileParam}`;
        const sg = await fetch(signUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresIn: 600 }),
        });
        if (!sg.ok) { const t = await sg.text().catch(() => ''); return res.status(500).json({ ok: false, error: `Falha ao gerar link (${sg.status}): ${t.slice(0,200)}` }); }
        const sj = await sg.json();
        const signed = sj.signedURL || sj.signedUrl || '';
        return res.status(200).json({ ok: true, url: signed ? `${SUPABASE_URL}/storage/v1${signed}` : '' });
      }
      const raw = await redis.get(STORE_KEY);
      let value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const allowG = await scopeUnits(req, redis);
      if (allowG && value && Array.isArray(value.terceiros)) {
        const A = new Set(allowG);
        const keep = new Set();
        value.terceiros = value.terceiros.filter((t) => { const ok = A.has(String((t && t.unidade) || '').toUpperCase()); if (ok) keep.add(t.id); return ok; });
        if (Array.isArray(value.workers)) value.workers = value.workers.filter((w) => keep.has(w.tid));
      }
      return res.status(200).json({ value: value ?? null });
    }

    if (req.method === 'POST') {
      // ── MATRIZES de referência (somente ADM/SGI) ──
      if (req.query && req.query.matrizes) {
        const role = await roleOf(req, redis);
        if (!(role === 'ADM' || role === 'SGI')) return res.status(403).json({ ok: false, error: 'Apenas ADM/SGI podem editar as matrizes.' });
        const mb = await readJson(req);
        const value = (mb && mb.matrizes) ? mb.matrizes : mb;
        if (value && typeof value === 'object') { value._updatedAt = new Date().toISOString(); value._updatedBy = emailFromReq(req); }
        await redis.set('terceiros_matrizes', JSON.stringify(value));
        try { await logEvent({ byEmail: emailFromReq(req), action: 'Editou matrizes de referência', modulo: 'Terceiros', item: 'Matriz Base/Complementares/Mão de Obra/Grupos/Criticidades' }); } catch(e){}
        return res.status(200).json({ ok: true });
      }
      // ── MANUAIS: salvar metadados (somente ADM/SGI) ──
      if (req.query && req.query.manuais) {
        const role = await roleOf(req, redis);
        if (!(role === 'ADM' || role === 'SGI')) return res.status(403).json({ ok: false, error: 'Apenas ADM/SGI podem gerenciar manuais.' });
        const b = await readJson(req);
        const arr = Array.isArray(b && b.manuais) ? b.manuais : (Array.isArray(b) ? b : []);
        await redis.set('manuais', JSON.stringify(arr));
        try { await logEvent({ byEmail: emailFromReq(req), action: 'Atualizou manuais', modulo: 'Manual', item: arr.length + ' manual(is)' }); } catch(e){}
        return res.status(200).json({ ok: true });
      }
      // ── E-MAIL: reprovação de documento / cobrança de pendências ──
      const _q = req.query || {};
      // ── AUDITORIA: salvar com merge no servidor (multi-auditor, atomico) ──
      if (_q.audsave) {
        const aid = String(_q.audsave).replace(/^auditoria:/, '');
        if (!/^[A-Za-z0-9_.:-]{1,90}$/.test(aid)) return res.status(400).json({ ok: false, error: 'id inválido' });
        const akey = 'auditoria:' + aid;
        const ab = await readJson(req);
        const incoming = (ab && ab.value) || {};
        const base = (ab && ab.base) || {};
        let remote = null;
        try { const raw = await redis.get(akey); remote = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) {}
        const merged = (remote && typeof remote === 'object' && (remote.home || remote.sectors)) ? audMerge3(base, incoming, remote) : incoming;
        merged._updatedAt = new Date().toISOString();
        await redis.set(akey, JSON.stringify(merged));
        return res.status(200).json({ ok: true, value: merged });
      }
      if (_q.planoom !== undefined) {
        try {
          const ab = await readJson(req);
          const { buildPlanoOMXlsx } = require('../lib/rnc_excel');
          const buf = await buildPlanoOMXlsx(ab || {});
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', 'attachment; filename="Plano_de_Acao_OM.xlsx"');
          res.statusCode = 200;
          return res.end(buf);
        } catch (e) { return res.status(500).json({ ok: false, error: 'Falha ao gerar Plano de Acao: ' + ((e && e.message) || e) }); }
      }
      if (_q.notify === 'reprova' || _q.cobrar !== undefined) {
        const b = await readJson(req);
        if (!gmailConfigured()) return res.status(200).json({ ok: false, error: 'Gmail não configurado (GMAIL_USER/GMAIL_APP_PASSWORD)' });
        const to = String((b && b.to) || '').trim();
        if (!to) return res.status(200).json({ ok: false, error: 'Fornecedor sem e-mail cadastrado' });
        const BASE = _baseUrl();
        const _areas = (_q.notify === 'reprova') ? [b.area] : (Array.isArray(b.areas) ? b.areas : []);
        const cc = await ccPorAreas(redis, b.unidade, _areas);
        try {
          if (_q.notify === 'reprova') {
            await sendMail({ to, cc, subject: 'Documento reprovado — ' + (b.terceiro || ''), html: reprovaHtml(b, BASE) });
            await logEvent({ byEmail: emailFromReq(req), action: 'Reprovou documento (e-mail ao fornecedor' + (cc.length ? ', responsável da área em cópia' : '') + ')', modulo: 'Terceiros', item: (b.doc || '') + ' — ' + (b.terceiro || '') });
          } else {
            await sendMail({ to, cc, subject: 'Documentos pendentes — ' + (b.terceiro || ''), html: cobrancaHtml(b, BASE) });
            await logEvent({ byEmail: emailFromReq(req), action: 'Cobrou documentos (e-mail ao fornecedor' + (cc.length ? ', responsável da área em cópia' : '') + ')', modulo: 'Terceiros', item: (b.terceiro || '') + ' — ' + ((b.itens || []).length) + ' item(ns)' });
          }
          return res.status(200).json({ ok: true });
        } catch (e) { return res.status(200).json({ ok: false, error: e.message || String(e) }); }
      }

      // ── AUDITORIA: emitir NC(s) — 1 e-mail por setor ──
      if (_q.rnc === 'emit') {
        const role = await roleOf(req, redis);
        if (!(role === 'ADM' || role === 'SGI' || role === 'Gestor')) return res.status(403).json({ ok: false, error: 'Sem permissão.' });
        const b = await readJson(req);
        const items = Array.isArray(b && b.items) ? b.items : [];
        const recipientsBySetor = (b && b.recipientsBySetor) || {};
        const audId = (b && b.audId) || '';
        if (!items.length) return res.status(400).json({ ok: false, error: 'Nenhuma NC para emitir.' });
        const rawR = await redis.get('rnc_records');
        let recs = Array.isArray(rawR) ? rawR : (rawR ? JSON.parse(rawR) : []);
        const now = new Date(); const mm = String(now.getMonth() + 1).padStart(2, '0'); const yy = now.getFullYear();
        const genId = function () { return 'rnc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
        const genTok = function () { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); };
        let seq = recs.length;
        const SRC = ['setor', 'unidade', 'grau', 'norma', 'clausula', 'requisito', 'descricao', 'evidencia', 'comentario', 'emitente', 'cliente', 'dataEmissao'];
        const keyOf = function (it) { return audId + '|' + (it.setor || '') + '|' + (it.clausula || ''); };
        items.forEach(function (it) {
          const ck = keyOf(it);
          let rec = recs.find(function (x) { return x.clientKey === ck && x.status !== 'concluida'; });
          if (!rec) {
            seq++;
            rec = { id: genId(), token: genTok(), clientKey: ck, num: 'AUD-' + mm + '/' + yy + '-' + String(seq).padStart(3, '0'), audId: audId, createdAt: new Date().toISOString(), history: [], status: 'emitida' };
            recs.push(rec);
          }
          SRC.forEach(function (k) { if (it[k] !== undefined) rec[k] = it[k]; });
          if (!rec.unidade && b.unidade) rec.unidade = b.unidade;
          rec.recipients = String(recipientsBySetor[it.setor] || '').split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean);
          rec.status = rec.status === 'concluida' ? 'concluida' : 'emitida';
          rec.emitidaEm = new Date().toISOString();
          rec.updatedAt = rec.emitidaEm;
        });
        const bySetor = {};
        items.forEach(function (it) {
          const rec = recs.find(function (x) { return x.clientKey === keyOf(it); });
          if (rec) (bySetor[it.setor] = bySetor[it.setor] || []).push(rec);
        });
        const base = _baseUrl();
        const report = [];
        for (const setor of Object.keys(bySetor)) {
          const list = bySetor[setor];
          const to = (list[0] && list[0].recipients) || [];
          if (!to.length) { report.push({ setor: setor, enviado: false, motivo: 'sem e-mails cadastrados' }); continue; }
          try {
            if (!gmailConfigured()) throw new Error('Gmail não configurado');
            await sendMail({ to: to, subject: 'Não conformidade(s) para tratamento — ' + setor, html: rncEmailHtml(setor, list, base) });
            report.push({ setor: setor, enviado: true, para: to, ncs: list.length });
          } catch (e) { report.push({ setor: setor, enviado: false, erro: e.message || String(e) }); }
        }
        await redis.set('rnc_records', JSON.stringify(recs));
        const outRecs = items.map(function (it) {
          const rec = recs.find(function (x) { return x.clientKey === keyOf(it); });
          return rec ? { clientKey: rec.clientKey, id: rec.id, token: rec.token, num: rec.num, setor: rec.setor } : null;
        }).filter(Boolean);
        try { await logEvent({ byEmail: emailFromReq(req), action: 'Emitiu NC(s)', modulo: 'Auditoria', item: items.length + ' NC(s) em ' + Object.keys(bySetor).length + ' setor(es)' }); } catch (e) {}
        return res.status(200).json({ ok: true, report: report, records: outRecs });
      }
      // ── DOCUMENTOS INTERNOS: verificar vencimentos (envia e-mails) ──
      if (_q.docint === 'check') {
        const role = await roleOf(req, redis);
        if (!(role === 'ADM' || role === 'SGI' || role === 'Gestor')) return res.status(403).json({ ok: false, error: 'Sem permissão.' });
        const out = await checkDocint(redis, { sendMail, gmailConfigured }, _baseUrl());
        return res.status(200).json(out);
      }
      // ── DOCUMENTOS INTERNOS: salvar (merge por unidade) ──
      if (_q.docint) {
        const bd = await readJson(req);
        const incoming = Array.isArray(bd && bd.docs) ? bd.docs : (Array.isArray(bd) ? bd : []);
        const oldRawD = await redis.get('documentos_vencimento');
        const oldD = Array.isArray(oldRawD) ? oldRawD : (oldRawD ? JSON.parse(oldRawD) : []);
        const scopeS = await docintScope(req, redis);
        let valueD = incoming;
        if (scopeS) {
          const inS = function (d) { return _docintIn(scopeS, d); };
          const otherD = oldD.filter(function (d) { return !inS(d); });           // preserva o que o usuário não enxerga
          const oldIds = new Set(oldD.map(function (d) { return d.id; }));
          const myD = incoming.filter(inS).concat(                                  // os que estão no escopo dele
            incoming.filter(function (d) { return !inS(d) && !oldIds.has(d.id); })  // novos: força para a unidade dele
                    .map(function (d) { if (scopeS.units.length) d.unidade = scopeS.units[0]; return d; })
          );
          valueD = otherD.concat(myD);
        }
        await redis.set('documentos_vencimento', JSON.stringify(valueD));
        try { await logEvent({ byEmail: emailFromReq(req), action: 'Salvou documentos internos', modulo: 'Documentos internos', item: valueD.length + ' documento(s)' }); } catch (e) {}
        return res.status(200).json({ ok: true });
      }
      // ── UPLOAD (multipart) via REST de Storage ──
      if (ct.includes('multipart/form-data')) {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
          return res.status(500).json({ ok: false, error: 'Supabase não configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY)' });
        const boundaryMatch = ct.match(/boundary=(.+)/);
        if (!boundaryMatch) return res.status(400).json({ ok: false, error: 'Content-Type inválido' });
        const parts = parseMultipart(await readRaw(req), boundaryMatch[1].trim().replace(/^"|"$/g, ''));
        const filePart = parts.find(p => p.name === 'file');
        const tidPart  = parts.find(p => p.name === 'terceiroId');
        const keyPart  = parts.find(p => p.name === 'docKey');
        const scopePart= parts.find(p => p.name === 'scope');
        if (!filePart || !filePart.filename) return res.status(400).json({ ok: false, error: 'Arquivo não encontrado' });
        const safeName   = sanit(filePart.filename, 'arquivo');
        let path;
        const _sc = scopePart ? scopePart.data.toString().trim() : '';
        if (_sc === 'manual') {
          const role = await roleOf(req, redis);
          if (!(role === 'ADM' || role === 'SGI')) return res.status(403).json({ ok: false, error: 'Apenas ADM/SGI podem enviar manuais.' });
          path = `manuais/${Date.now()}_${safeName}`;
        } else if (_sc === 'docint') {
          const role = await roleOf(req, redis);
          if (!(role === 'ADM' || role === 'SGI' || role === 'Gestor')) return res.status(403).json({ ok: false, error: 'Sem permissão para enviar arquivo.' });
          path = `docint/${Date.now()}_${safeName}`;
        } else {
          const terceiroId = sanit(tidPart ? tidPart.data.toString().trim() : '', 'sem_terceiro');
          const docKey     = sanit(keyPart ? keyPart.data.toString().trim() : '', 'doc');
          path = `${terceiroId}/${docKey}_${Date.now()}_${safeName}`;
        }

        const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`;
        const up = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
            'Content-Type': filePart.contentType || 'application/octet-stream',
            'x-upsert': 'false',
            'cache-control': '3600',
          },
          body: filePart.data,
        });
        if (!up.ok) {
          const txt = await up.text().catch(() => '');
          console.error('Storage upload falhou:', up.status, txt);
          return res.status(500).json({ ok: false, error: `Falha no upload (${up.status}): ${txt.slice(0, 200)}` });
        }
        return res.status(200).json({ ok: true, path, fileName: filePart.filename });
      }

      // ── SAVE (json) ──
      const body = await readJson(req);
      let value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : body;
      const oldRaw = await redis.get(STORE_KEY);
      const oldState = typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw;
      // escopo por unidade: mescla preservando as outras unidades (sem perda de dados)
      const allowS = await scopeUnits(req, redis);
      if (allowS && value && typeof value === 'object') {
        const A = new Set(allowS);
        const inUnit = (t) => A.has(String((t && t.unidade) || '').toUpperCase());
        const oldT2 = (oldState && oldState.terceiros) || [];
        const incT = (value.terceiros || []);
        const otherT = oldT2.filter((t) => !inUnit(t));
        const oldIdSet = new Set(oldT2.map((t) => t.id));
        // terceiros novos criados fora da unidade permitida são marcados com a unidade do usuário (evita perda)
        const myT = incT.filter(inUnit).concat(
          incT.filter((t) => !inUnit(t) && !oldIdSet.has(t.id)).map((t) => { t.unidade = allowS[0]; return t; })
        );
        value.terceiros = otherT.concat(myT);
        const otherTids = new Set(otherT.map((t) => t.id));
        const myTids = new Set(myT.map((t) => t.id));
        const oldW2 = (oldState && oldState.workers) || [];
        const incW = (value.workers || []);
        const otherW = oldW2.filter((w) => otherTids.has(w.tid));
        const myW = incW.filter((w) => myTids.has(w.tid));
        value.workers = otherW.concat(myW);
      }
      // diff antes/depois: registra inserções/remoções (não loga edições de campo, para não poluir)
      try {
        const byEmail = emailFromReq(req);
        const oldT = (oldState && oldState.terceiros) || [];
        const newT = (value && value.terceiros) || [];
        const oldTids = new Set(oldT.map(function(t){return t.id;}));
        const newTids = new Set(newT.map(function(t){return t.id;}));
        for (const t of newT) if (!oldTids.has(t.id)) await logEvent({ byEmail, action: 'Inseriu terceiro', modulo: 'Terceiros', item: t.razaoSocial || t.cnpj || t.id });
        for (const t of oldT) if (!newTids.has(t.id)) await logEvent({ byEmail, action: 'Removeu terceiro', modulo: 'Terceiros', item: t.razaoSocial || t.cnpj || t.id });
        const oldW = (oldState && oldState.workers) || [];
        const newW = (value && value.workers) || [];
        const oldWids = new Set(oldW.map(function(w){return w.id;}));
        const newWids = new Set(newW.map(function(w){return w.id;}));
        const tname = function(tid){ const t = newT.find(function(x){return x.id===tid;}) || oldT.find(function(x){return x.id===tid;}); return t ? (t.razaoSocial || '') : ''; };
        for (const w of newW) if (!oldWids.has(w.id)) await logEvent({ byEmail, action: 'Inseriu colaborador', modulo: 'Terceiros', item: (w.nome || w.id) + (tname(w.tid) ? (' — ' + tname(w.tid)) : '') });
        for (const w of oldW) if (!newWids.has(w.id)) await logEvent({ byEmail, action: 'Removeu colaborador', modulo: 'Terceiros', item: (w.nome || w.id) });
      } catch (e) {}
      await redis.set(STORE_KEY, JSON.stringify(value));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('terc error:', err); // detalhe só no log do servidor
    return res.status(500).json({ ok: false, error: 'Erro interno.' });
  }
};
