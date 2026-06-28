// lib/gmail.js — envio de e-mail pelo Gmail (SMTP) via Nodemailer.
// Usa GMAIL_USER + GMAIL_APP_PASSWORD. Remetente = o próprio GMAIL_USER.
const nodemailer = require('nodemailer');

let _t = null;
function transporter() {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!_t) _t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  return _t;
}
function gmailConfigured() { return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD); }
async function sendMail({ to, subject, html, replyTo, cc, attachments }) {
  const t = transporter();
  if (!t) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD nao configurados');
  const fromName = process.env.MAIL_FROM_NAME || 'Central SGI';
  return t.sendMail({
    from: '"' + fromName + '" <' + process.env.GMAIL_USER + '>',
    to: Array.isArray(to) ? to.join(', ') : to,
    ...((cc && (Array.isArray(cc) ? cc.length : cc)) ? { cc: Array.isArray(cc) ? cc.join(', ') : cc } : {}),
    subject: subject,
    html: html,
    ...(replyTo ? { replyTo: replyTo } : {}),
    ...((attachments && attachments.length) ? { attachments: attachments } : {}),
  });
}
module.exports = { sendMail, gmailConfigured };
