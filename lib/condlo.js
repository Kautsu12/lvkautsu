// lib/condlo.js — Condicionantes da Licença de Operação (LO)
// Verificação diária: avisa o responsável antes de cada prazo (antecedência conforme a
// frequência), cobra diariamente quando vencida (gestor entra como destinatário no 3º dia)
// e vigia o marco legal de renovação da LO (protocolar com 120 dias de antecedência).
// TO = responsável da condicionante; CC = ADM. Reaproveita o padrão de lib/docint.js.
const crypto = require('crypto');

const STORE_KEY = 'condicionantes_lo';

function daysUntil(s) {
  if (!s) return null;
  const t = new Date(String(s) + 'T00:00:00'); if (isNaN(t)) return null;
  const h = new Date(); h.setHours(0, 0, 0, 0);
  return Math.floor((t - h) / 86400000);
}
function fmtBR(iso) { if (!iso) return '-'; const p = String(iso).split('-'); return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : iso; }
function esc(x) { return String(x == null ? '' : x).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

// Antecedência dos avisos conforme a frequência (decisão aprovada em 07/2026)
function leadDaysFor(freq) {
  const f = String(freq || '').toLowerCase();
  if (f === 'mensal') return [7, 3, 1];
  if (f === 'trimestral') return [15, 7, 1];
  return [30, 15, 7, 1]; // semestral, anual, única, contínua-com-prazo
}

// Próxima ocorrência a partir da data cumprida (YYYY-MM-DD) e da frequência
function nextDate(iso, freq) {
  const f = String(freq || '').toLowerCase();
  const add = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[f];
  if (!add) return null; // única/contínua: sem próxima automática
  const d = new Date(String(iso) + 'T00:00:00'); if (isNaN(d)) return null;
  const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + add);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

async function readStore(redis) {
  let st = null;
  try { const raw = await redis.get(STORE_KEY); st = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { st = null; }
  if (!st || typeof st !== 'object') st = {};
  if (!Array.isArray(st.licencas)) st.licencas = [];
  if (!Array.isArray(st.conds)) st.conds = [];
  return st;
}

async function usersByRole(redis) {
  const out = { adm: [], gestores: {} }; // gestores por unidade (UPPER)
  try {
    const raw = await redis.get('sgi_users');
    const u = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
    Object.keys(u).forEach(function (email) {
      const rec = u[email] || {};
      const e = String(email).toLowerCase();
      if (rec.role === 'ADM') out.adm.push(e);
      if (rec.role === 'Gestor') (Array.isArray(rec.unidades) ? rec.unidades : []).forEach(function (un) {
        const U = String(un).toUpperCase();
        (out.gestores[U] = out.gestores[U] || []).push(e);
      });
    });
  } catch (e) {}
  if (!out.adm.length) out.adm = ['ayrton.ribeiro@galvanizacaoraitz.com.br'];
  return out;
}

function mailShell(titulo, cor, rowsHtml, botoes, rodape) {
  return '<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto">'
    + '<div style="background:#0d2137;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0"><div style="font-size:14px;font-weight:700">Central SGI</div><div style="font-size:12px;opacity:.7;margin-top:3px">Condicionantes da Licença de Operação</div></div>'
    + '<div style="border:1px solid #e2e8f0;border-top:0;padding:22px;border-radius:0 0 8px 8px">'
    + '<div style="font-size:18px;font-weight:700;color:' + cor + ';margin-bottom:14px">' + titulo + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">' + rowsHtml + '</table>'
    + (botoes || '')
    + (rodape ? '<div style="padding:12px;background:#f8fafc;border-radius:6px;font-size:11.5px;color:#64748b;line-height:1.5;margin-top:14px">' + rodape + '</div>' : '')
    + '</div><div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:12px">E-mail automático do Central SGI.</div></div>';
}
function row(k, v, bold, cor) {
  return '<tr><td style="padding:8px 0;color:#64748b;width:140px">' + k + '</td><td style="padding:8px 0;' + (bold ? 'font-weight:700;' : '') + (cor ? 'color:' + cor : '') + '">' + v + '</td></tr>';
}
function btn(href, label, bg) {
  return '<a href="' + href + '" style="flex:1;min-width:180px;display:block;background:' + bg + ';color:#fff;text-decoration:none;padding:13px 16px;border-radius:7px;text-align:center;font-weight:600;font-size:13px">' + label + '</a>';
}

// mailer = { sendMail, gmailConfigured } ; siteUrl = base https
async function checkCondLo(redis, mailer, siteUrl) {
  const st = await readStore(redis);
  if (!mailer.gmailConfigured()) return { ok: false, error: 'Gmail nao configurado' };
  const who = await usersByRole(redis);
  const results = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const base = String(siteUrl || '').startsWith('http') ? siteUrl : ('https://' + siteUrl);
  const licById = {};
  st.licencas.forEach(function (l) { licById[l.id] = l; });

  // ── 1. condicionantes ──
  for (const c of st.conds) {
    if (c.atendida || !c.proximoPrazo) continue;
    const dias = daysUntil(c.proximoPrazo);
    if (dias === null) continue;
    const leads = leadDaysFor(c.frequencia);
    c.notifiedDays = c.notifiedDays || [];
    let lead = null;
    if (dias < 0) lead = 'vencido'; else if (leads.indexOf(dias) !== -1) lead = dias;
    if (lead === null) continue;
    const key = String(lead);
    if (c.notifiedDays.find(function (n) { return n.leadDay === key && n.date === todayStr; })) continue;

    const lic = licById[c.licencaId] || {};
    const unidade = String(lic.unidade || '').toUpperCase();
    let to = c.responsavelEmail ? [String(c.responsavelEmail).toLowerCase()] : [];
    let cc = who.adm.slice();
    // escalonamento: 3º dia vencida -> gestores da unidade entram como destinatários
    if (dias <= -3) to = to.concat(who.gestores[unidade] || []);
    to = Array.from(new Set(to));
    cc = cc.filter(function (e) { return to.indexOf(e) === -1; });
    if (!to.length && !cc.length) { results.push({ id: c.id, status: 'sem_destinatarios', dias: dias }); continue; }

    if (!c.token) c.token = crypto.randomBytes(16).toString('hex');
    const cumprirUrl = base + '/cumprir.html?id=' + encodeURIComponent(c.id) + '&token=' + c.token;
    const titulo = lead === 'vencido' ? ('Condicionante VENCIDA há ' + Math.abs(dias) + ' dia(s)') : ('Condicionante vence em ' + lead + ' dia(s)');
    const cor = lead === 'vencido' ? '#b91c1c' : '#c2410c';
    const rows = row('Licença', esc((lic.numero || '-') + (lic.orgao ? ' — ' + lic.orgao : '')))
      + row('Condicionante', '<strong>' + esc((c.num ? c.num + ' — ' : '') + (c.descricao || '-')) + '</strong>')
      + row('Frequência', esc(c.frequencia || '-'))
      + row('Unidade', esc(lic.unidade || '-'))
      + row('Responsável', esc(c.responsavel || '-'))
      + row('Prazo', fmtBR(c.proximoPrazo), true, cor);
    const botoes = '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      + btn(cumprirUrl, '✓ Registrar cumprimento', '#15803d')
      + (c.pastaPadrao ? btn(c.pastaPadrao, 'Abrir pasta de evidências', '#1565c0') : '')
      + '</div>';
    const rodape = (lead === 'vencido'
      ? 'Esta condicionante <strong>JÁ VENCEU</strong>. Regularize o quanto antes.' + (dias <= -3 ? ' Os gestores da unidade foram incluídos neste aviso.' : '')
      : 'Faltam <strong>' + lead + ' dia(s)</strong> para o prazo.')
      + '<br><br>Após cumprir, clique em <strong>"Registrar cumprimento"</strong> e informe data, protocolo e evidência — o sistema agenda a próxima ocorrência sozinho.';
    try {
      await mailer.sendMail({ to: to.length ? to : cc, cc: to.length ? cc : [], subject: '[Central SGI] ' + titulo + ': ' + (c.num || '') + ' ' + String(c.descricao || '').slice(0, 60), html: mailShell(titulo, cor, rows, botoes, rodape) });
      c.notifiedDays.push({ leadDay: key, date: todayStr, sentTo: to.concat(cc) });
      results.push({ id: c.id, status: 'enviado', dias: dias, to: to, cc: cc });
    } catch (e) { results.push({ id: c.id, status: 'erro', dias: dias, error: e.message }); }
  }

  // ── 2. marco de renovação da LO (protocolar com 120 dias de antecedência) ──
  for (const lic of st.licencas) {
    if (!lic.validade || (lic.renovacaoPedida && lic.renovacaoPedida.data)) continue;
    const diasV = daysUntil(lic.validade);
    if (diasV === null || diasV > 150) continue;
    lic.notifiedRenew = lic.notifiedRenew || [];
    let mark = null;
    if (diasV === 150 || diasV === 135 || diasV === 120) mark = String(diasV);
    else if (diasV < 120 && diasV >= 0 && diasV % 7 === 0) mark = 'semanal-' + diasV;
    else if (diasV < 0) mark = 'expirada';
    if (mark === null) continue;
    if (lic.notifiedRenew.find(function (n) { return n.mark === mark && n.date === todayStr; })) continue;
    if (mark === 'expirada' && lic.notifiedRenew.find(function (n) { return n.mark === 'expirada'; })) {
      // expirada: avisa 1x por semana, não todo dia
      const last = lic.notifiedRenew.filter(function (n) { return n.mark === 'expirada'; }).pop();
      if (last && daysUntil(last.date) > -7) continue;
    }
    const unidade = String(lic.unidade || '').toUpperCase();
    const to = Array.from(new Set(who.adm.concat(who.gestores[unidade] || [])));
    const dentro = diasV >= 120;
    const titulo = diasV < 0 ? 'LICENÇA DE OPERAÇÃO VENCIDA' : (dentro ? ('Renovação da LO: janela abre em ' + (diasV - 120) + ' dia(s)') : ('URGENTE: renovação da LO — restam ' + diasV + ' dias de validade'));
    const cor = dentro ? '#c2410c' : '#b91c1c';
    const rows = row('Licença', '<strong>' + esc(lic.numero || '-') + (lic.orgao ? ' — ' + esc(lic.orgao) : '') + '</strong>')
      + row('Unidade', esc(lic.unidade || '-'))
      + row('Validade', fmtBR(lic.validade), true, cor)
      + row('Marco legal', 'protocolar a renovação com <strong>120 dias</strong> de antecedência');
    const rodape = diasV < 0 ? 'A licença <strong>expirou</strong>. Trate como prioridade máxima.'
      : (dentro ? 'Prepare a documentação: o pedido deve ser protocolado até ' + fmtBR(nextDateISO(lic.validade, -120)) + '.'
        : 'A janela legal dos 120 dias <strong>já passou</strong>. Protocole imediatamente e registre o pedido no painel.');
    try {
      await mailer.sendMail({ to: to, subject: '[Central SGI] ' + titulo + ' — ' + (lic.numero || ''), html: mailShell(titulo, cor, rows, '', rodape) });
      lic.notifiedRenew.push({ mark: mark, date: todayStr, sentTo: to });
      results.push({ id: lic.id, status: 'renovacao_enviada', diasValidade: diasV });
    } catch (e) { results.push({ id: lic.id, status: 'erro_renovacao', error: e.message }); }
  }

  try { await redis.set(STORE_KEY, JSON.stringify(st)); } catch (e) {}
  try {
    const logRaw = await redis.get('notifications_log');
    const log = Array.isArray(logRaw) ? logRaw : (logRaw ? JSON.parse(logRaw) : []);
    log.unshift({ at: new Date().toISOString(), scope: 'condlo', results: results });
    await redis.set('notifications_log', JSON.stringify(log.slice(0, 60)));
  } catch (e) {}
  return { ok: true, condicionantes: st.conds.length, licencas: st.licencas.length, results: results };
}

function nextDateISO(iso, offsetDays) {
  const d = new Date(String(iso) + 'T00:00:00');
  if (isNaN(d)) return iso;
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

module.exports = { checkCondLo, nextDate, leadDaysFor, STORE_KEY };
