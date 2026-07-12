// api/portal-cron.js
// Cron diario (modelo novo 'terceiros_sgi'):
//   - avisa cada FORNECEDOR sobre documentos vencidos / a vencer (30/15/7/1 dias)
//   - envia DIGEST interno: ADM/SGI recebem tudo; cada Gestor recebe so a(s) sua(s) unidade(s)
// Envio via Gmail SMTP (lib/gmail). Auditoria nao entra aqui (e so vencimento de Terceiros).
const { Redis } = require('@upstash/redis');
const { sendMail, gmailConfigured } = require('../lib/gmail');
const { checkDocint } = require('../lib/docint');
const { checkCondLo } = require('../lib/condlo');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const CRON_SECRET = process.env.CRON_SECRET || '';
const STORE_KEY   = 'terceiros_sgi';
const BASE_URL    = 'https://' + (process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'project-l4zew.vercel.app').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const THRESHOLDS  = [30, 15, 7, 1];

function daysUntil(s) {
  if (!s) return null;
  const t = new Date(String(s) + 'T00:00:00');
  if (isNaN(t)) return null;
  const h = new Date(); h.setHours(0, 0, 0, 0);
  return Math.floor((t - h) / 86400000);
}
function fmtBR(iso) { if (!iso) return '-'; const p = String(iso).split('-'); return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : iso; }
function esc(x) { return String(x == null ? '' : x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
function sitText(a) {
  if (a.tipo === 'vencido') return 'Vencido em ' + fmtBR(a.validade);
  return 'Vence em ' + a.dias + ' dia' + (a.dias === 1 ? '' : 's') + ' (' + fmtBR(a.validade) + ')';
}
function sitColor(a) { return a.tipo === 'vencido' ? '#dc2626' : '#d97706'; }

function supplierHtml(nome, alertas) {
  const rows = alertas.map(function (a) {
    return '<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">' + esc(a.nome) + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:' + sitColor(a) + ';font-weight:600">' + sitText(a) + '</td></tr>';
  }).join('');
  return '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">' +
    '<h2 style="color:#0d2137">Documentos a vencer</h2>' +
    '<p>Ola! Os seguintes documentos de <strong>' + esc(nome) + '</strong> precisam de atencao:</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e2e8f0">' +
    '<thead><tr style="background:#f8fafc"><th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b">Documento</th><th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b">Situacao</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<a href="' + BASE_URL + '/portal.html" style="display:inline-block;background:#1a56db;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin:8px 0 20px">Acessar Portal</a>' +
    '<p style="color:#94a3b8;font-size:12px">E-mail automatico do sistema Central SGI.</p></div>';
}
function internalHtml(itens) {
  const rows = itens.map(function (a) {
    return '<tr>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px">' + esc(a.unidade || '-') + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px">' + esc(a.terceiro) + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px">' + esc(a.nome) + '</td>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:' + sitColor(a) + ';font-weight:600">' + sitText(a) + '</td></tr>';
  }).join('');
  return '<div style="font-family:sans-serif;max-width:720px;margin:0 auto;padding:24px">' +
    '<h2 style="color:#0d2137">Painel de vencimentos - Terceiros</h2>' +
    '<p>Documentos vencidos ou a vencer nos proximos 30 dias:</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e2e8f0">' +
    '<thead><tr style="background:#f8fafc">' +
    '<th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b">Unidade</th>' +
    '<th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b">Terceiro</th>' +
    '<th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b">Documento</th>' +
    '<th style="padding:9px 10px;text-align:left;font-size:11px;color:#64748b">Situacao</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '<a href="' + BASE_URL + '/" style="display:inline-block;background:#1a56db;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin:8px 0 20px">Abrir SGI</a>' +
    '<p style="color:#94a3b8;font-size:12px">E-mail automatico do sistema Central SGI.</p></div>';
}

function ccPorAreas(mapa, unidade, areas) {
  const U = String(unidade || '').toUpperCase();
  const set = {};
  (areas || []).forEach(function (ar) {
    if (!ar) return;
    let m = mapa[U] && mapa[U][ar];
    if (!(Array.isArray(m) && m.length)) m = mapa['TODAS'] && mapa['TODAS'][ar];
    if (Array.isArray(m)) m.forEach(function (e) { if (e) set[String(e).toLowerCase()] = 1; });
  });
  return Object.keys(set);
}

module.exports = async function handler(req, res) {
  // SEGURANCA: confia apenas no segredo do cron (Bearer). User-Agent e forjavel.
  const isVercelCron = !!CRON_SECRET && (req.headers.authorization || '') === 'Bearer ' + CRON_SECRET;
  const isManual     = CRON_SECRET && (req.query && req.query.secret === CRON_SECRET);
  if (!isVercelCron && !isManual) return res.status(401).json({ ok: false, error: 'Nao autorizado' });

  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  const raw = await redis.get(STORE_KEY);
  const state = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  const terceiros = Array.isArray(state.terceiros) ? state.terceiros : [];
  const workers   = Array.isArray(state.workers) ? state.workers : [];

  const rawU = await redis.get('sgi_users');
  const users = (typeof rawU === 'string' ? JSON.parse(rawU) : rawU) || {};

  const rawAR = await redis.get('area_responsaveis');
  let _allAR = (typeof rawAR === 'string' ? JSON.parse(rawAR) : rawAR) || {};
  const _ARU = ['TODAS','RESENDE','JOINVILLE','CURITIBA'];
  const _ARk = Object.keys(_allAR);
  if (_ARk.length && _ARk.every(function(x){ return _ARU.indexOf(String(x).toUpperCase()) !== -1; })) _allAR = { terceiros: _allAR };
  const areaResp = _allAR['terceiros'] || {};

  if (!gmailConfigured()) return res.status(200).json({ ok: false, error: 'Gmail nao configurado (GMAIL_USER/GMAIL_APP_PASSWORD)' });

  const report = { fornecedores: 0, internos: 0, erros: 0, detalhes: [] };
  const internalItems = [];

  function classify(d) {
    const dias = daysUntil(d.validade);
    if (dias === null) return null;
    if (dias < 0) return { tipo: 'vencido', validade: d.validade, dias: dias };
    if (dias <= 30) return { tipo: 'avence', validade: d.validade, dias: dias };
    return null;
  }

  for (const t of terceiros) {
    const unidade = String(t.unidade || '').toUpperCase();
    const myWorkers = workers.filter(function (w) { return w.tid === t.id; });
    const collected = [];
    (t.docs || []).forEach(function (d) { const c = classify(d); if (c) collected.push(Object.assign({ nome: d.nome, area: d.area || '' }, c)); });
    myWorkers.forEach(function (w) { (w.wdocs || []).forEach(function (d) { const c = classify(d); if (c) collected.push(Object.assign({ nome: (w.nome || 'Colaborador') + ': ' + d.nome, area: d.area || '' }, c)); }); });
    if (!collected.length) continue;

    collected.forEach(function (a) { internalItems.push({ unidade: unidade, terceiro: t.razaoSocial, nome: a.nome, tipo: a.tipo, validade: a.validade, dias: a.dias }); });

    const supplierAlerts = collected.filter(function (a) { return a.tipo === 'vencido' || THRESHOLDS.indexOf(a.dias) !== -1; });
    if (t.email && supplierAlerts.length) {
      try {
        const areasSet = Array.from(new Set(supplierAlerts.map(function (a) { return a.area; }).filter(Boolean)));
        const ccGestores = ccPorAreas(areaResp, unidade, areasSet);
        await sendMail({ to: t.email, cc: ccGestores, subject: 'Documentos a vencer - ' + (t.razaoSocial || ''), html: supplierHtml(t.razaoSocial || '', supplierAlerts) });
        report.fornecedores++;
        report.detalhes.push({ tipo: 'fornecedor', terceiro: t.razaoSocial, email: t.email, itens: supplierAlerts.length });
      } catch (e) { report.erros++; report.detalhes.push({ tipo: 'fornecedor', terceiro: t.razaoSocial, erro: e.message }); }
    }
  }

  if (internalItems.length) {
    for (const email of Object.keys(users)) {
      const u = users[email] || {};
      const role = u.role;
      if (!email) continue;
      let mine = [];
      if (role === 'ADM' || role === 'SGI') {
        mine = internalItems;
      } else if (role === 'Gestor') {
        const un = Array.isArray(u.unidades) ? u.unidades.map(function (x) { return String(x).toUpperCase(); }) : [];
        if (!un.length) continue;
        mine = internalItems.filter(function (a) { return un.indexOf(a.unidade) !== -1; });
      } else {
        continue;
      }
      if (!mine.length) continue;
      try {
        await sendMail({ to: email, subject: 'Vencimentos de Terceiros - ' + mine.length + ' item(ns)', html: internalHtml(mine) });
        report.internos++;
        report.detalhes.push({ tipo: 'interno', email: email, role: role, itens: mine.length });
      } catch (e) { report.erros++; report.detalhes.push({ tipo: 'interno', email: email, erro: e.message }); }
    }
  }

  // Documentos Internos (modulo Vencimentos): envia avisos ao responsavel + ADM/SGI em copia
  let docint = null;
  try { docint = await checkDocint(redis, { sendMail, gmailConfigured }, BASE_URL); }
  catch (e) { docint = { ok: false, error: e.message }; }

  // Condicionantes da LO: avisos por frequencia + marco de renovacao (120 dias)
  let condlo = null;
  try { condlo = await checkCondLo(redis, { sendMail, gmailConfigured }, BASE_URL); }
  catch (e) { condlo = { ok: false, error: e.message }; }

  return res.status(200).json({ ok: true, fornecedores: report.fornecedores, internos: report.internos, erros: report.erros, detalhes: report.detalhes, docint: docint, condlo: condlo });
};

