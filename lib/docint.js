// lib/docint.js — verificação de vencimento dos Documentos Internos + envio de e-mail.
// TO = responsável do documento; CC = ADM apenas.
const crypto = require('crypto');

function daysUntil(s) {
  if (!s) return null;
  const t = new Date(String(s) + 'T00:00:00'); if (isNaN(t)) return null;
  const h = new Date(); h.setHours(0, 0, 0, 0);
  return Math.floor((t - h) / 86400000);
}
async function admEmails(redis) {
  try {
    const raw = await redis.get('sgi_users');
    const u = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
    let list = Object.keys(u).filter(function (e) { return u[e] && u[e].role === 'ADM'; });
    if (!list.length) list = ['ayrton.ribeiro@galvanizacaoraitz.com.br'];
    return list.map(function (e) { return String(e).toLowerCase(); });
  } catch (e) { return ['ayrton.ribeiro@galvanizacaoraitz.com.br']; }
}

// mailer = { sendMail, gmailConfigured } ; siteUrl = base https
async function checkDocint(redis, mailer, siteUrl) {
  let docs = [];
  try { const raw = await redis.get('documentos_vencimento'); docs = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []); } catch (e) { return { ok: false, error: 'Falha ao ler docs' }; }
  if (!mailer.gmailConfigured()) return { ok: false, error: 'Gmail nao configurado' };

  const adm = await admEmails(redis);
  const results = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const base = String(siteUrl || '').startsWith('http') ? siteUrl : ('https://' + siteUrl);

  for (const doc of docs) {
    if (!doc.dataVencimento || doc.status === 'inativo' || doc.status === 'renovado') continue;
    const dias = daysUntil(doc.dataVencimento);
    if (dias === null) continue;
    const leadDays = Array.isArray(doc.leadDays) && doc.leadDays.length ? doc.leadDays : [30, 15, 7, 1];
    doc.notifiedDays = doc.notifiedDays || [];
    let lead = null;
    if (dias < 0) lead = 'vencido'; else if (leadDays.indexOf(dias) !== -1) lead = dias;
    if (lead === null) continue;
    const key = String(lead);
    if (doc.notifiedDays.find(function (n) { return n.leadDay === key && n.date === todayStr; })) continue;

    // destinatários: responsável (TO) + ADM em cópia (CC)
    const to = doc.responsavelEmail ? [String(doc.responsavelEmail).toLowerCase()] : (Array.isArray(doc.recipients) && doc.recipients.length ? [String(doc.recipients[0]).toLowerCase()] : []);
    const cc = adm.filter(function (e) { return to.indexOf(e) === -1; });
    if (!to.length && !cc.length) { results.push({ id: doc.id, status: 'sem_destinatarios', dias: dias }); continue; }

    if (!doc.renewalToken) doc.renewalToken = crypto.randomBytes(16).toString('hex');
    const renewUrl = base + '/renew.html?docId=' + encodeURIComponent(doc.id) + '&token=' + doc.renewalToken;
    const pastaUrl = doc.pasta || doc.anexo || '';
    const titulo = lead === 'vencido' ? 'Documento VENCIDO' : ('Documento vence em ' + lead + ' dia(s)');
    const cor = lead === 'vencido' ? '#b91c1c' : '#c2410c';
    const html = '<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto">'
      + '<div style="background:#0d2137;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0"><div style="font-size:14px;font-weight:700">Central SGI</div><div style="font-size:12px;opacity:.7;margin-top:3px">Alerta de vencimento de documento</div></div>'
      + '<div style="border:1px solid #e2e8f0;border-top:0;padding:22px;border-radius:0 0 8px 8px">'
      + '<div style="font-size:18px;font-weight:700;color:' + cor + ';margin-bottom:14px">' + titulo + '</div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">'
      + '<tr><td style="padding:8px 0;color:#64748b;width:140px">Documento</td><td style="padding:8px 0;font-weight:600">' + (doc.nome || '-') + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#64748b">Tipo</td><td style="padding:8px 0">' + (doc.tipo || '-') + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#64748b">Unidade</td><td style="padding:8px 0">' + (doc.unidade || '-') + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#64748b">Responsável</td><td style="padding:8px 0">' + (doc.responsavel || '-') + '</td></tr>'
      + '<tr><td style="padding:8px 0;color:#64748b">Data de vencimento</td><td style="padding:8px 0;font-weight:700;color:' + cor + '">' + doc.dataVencimento + '</td></tr>'
      + '</table>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">'
      + (pastaUrl ? '<a href="' + pastaUrl + '" style="flex:1;min-width:180px;display:block;background:#1565c0;color:#fff;text-decoration:none;padding:13px 16px;border-radius:7px;text-align:center;font-weight:600;font-size:13px">Abrir documento</a>' : '')
      + '<a href="' + renewUrl + '" style="flex:1;min-width:180px;display:block;background:#15803d;color:#fff;text-decoration:none;padding:13px 16px;border-radius:7px;text-align:center;font-weight:600;font-size:13px">Já renovei — atualizar data</a>'
      + '</div>'
      + '<div style="padding:12px;background:#f8fafc;border-radius:6px;font-size:11.5px;color:#64748b;line-height:1.5">' + (lead === 'vencido' ? 'Este documento <strong>JÁ VENCEU</strong>. Renove o quanto antes.' : ('Faltam <strong>' + lead + ' dia(s)</strong> para o vencimento.')) + '<br><br>Após renovar, clique em <strong>"Já renovei"</strong> e informe a nova data — o sistema atualiza sozinho.</div>'
      + '</div><div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:12px">E-mail automático do Central SGI.</div></div>';

    try {
      await mailer.sendMail({ to: to.length ? to : cc, cc: to.length ? cc : [], subject: '[Central SGI] ' + titulo + ': ' + (doc.nome || ''), html: html });
      doc.notifiedDays.push({ leadDay: key, date: todayStr, sentTo: to.concat(cc) });
      results.push({ id: doc.id, status: 'enviado', dias: dias, to: to, cc: cc });
    } catch (e) { results.push({ id: doc.id, status: 'erro', dias: dias, error: e.message }); }
  }

  try { await redis.set('documentos_vencimento', JSON.stringify(docs)); } catch (e) {}
  try {
    const logRaw = await redis.get('notifications_log');
    const log = Array.isArray(logRaw) ? logRaw : (logRaw ? JSON.parse(logRaw) : []);
    log.unshift({ at: new Date().toISOString(), results: results });
    await redis.set('notifications_log', JSON.stringify(log.slice(0, 60)));
  } catch (e) {}
  return { ok: true, checked: docs.length, results: results };
}
module.exports = { checkDocint };
