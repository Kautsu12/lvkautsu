// api/portal-invite.js
const { Redis } = require('@upstash/redis');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendMail, gmailConfigured } = require('../lib/gmail');
const { getSession } = require('../lib/session');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

function getRedis() { return new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }

// Sessao interna server-side (Redis).
async function getUser(req) {
  const s = await getSession(req);
  return s ? (s.user || 'R') : null;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.body && typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function gerarSenhaTemp() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });
  if (!(await getUser(req))) return res.status(401).json({ ok: false, error: 'Não autenticado' });

  const { terceiroId, terceiroNome, email, nomeResponsavel } = await readBody(req);
  if (!terceiroId || !email) return res.status(400).json({ ok: false, error: 'terceiroId e email obrigatórios' });

  const emailNorm = email.toLowerCase().trim();
  const redis = getRedis();
  const users = (await redis.get('portal_users')) || {};

  const senhaTemp = gerarSenhaTemp();
  const hash = await bcrypt.hash(senhaTemp, 10);
  const isNew = !users[emailNorm];

  users[emailNorm] = {
    id: users[emailNorm]?.id || crypto.randomUUID(),
    email: emailNorm,
    passwordHash: hash,
    mustResetPassword: true,
    terceiroId,
    terceiroNome: terceiroNome || '',
    nomeResponsavel: nomeResponsavel || '',
    createdAt: users[emailNorm]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await redis.set('portal_users', users);

  const BASE_URL   = 'https://' + (process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'project-l4zew.vercel.app').replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (gmailConfigured()) {
    try {
      await sendMail({
        to: emailNorm,
        replyTo: process.env.MAIL_REPLY_TO || '',
        subject: isNew ? `Acesso ao Portal de Documentos — ${terceiroNome || 'Central SGI'}` : `Nova senha de acesso — Portal Central SGI`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#0d2137;margin-bottom:8px">${isNew ? 'Bem-vindo ao Portal de Gestão de Terceiros' : 'Nova senha de acesso'}</h2>
            <p style="color:#334155;margin:0 0 12px">Olá${nomeResponsavel ? ', ' + nomeResponsavel : ''}!</p>
            <p style="color:#334155;line-height:1.6;margin:0 0 12px">
              ${isNew
                ? `Você foi cadastrado no <strong>Portal de Gestão de Terceiros — Central SGI</strong> como responsável por <strong>${terceiroNome}</strong>. Por aqui a sua empresa mantém a documentação sempre em dia: anexando os documentos solicitados, cadastrando os colaboradores que prestam serviço e acompanhando os prazos de validade.`
                : `Este é o <strong>Portal de Gestão de Terceiros — Central SGI</strong>, onde a sua empresa mantém a documentação em dia: anexando os documentos solicitados, cadastrando os colaboradores que prestam serviço e acompanhando os prazos de validade.`}
            </p>
            <p style="color:#334155;line-height:1.6;margin:0 0 4px">
              ${isNew
                ? `Para começar, utilize os dados de acesso abaixo:`
                : `Geramos uma nova senha para o seu acesso. Utilize os dados abaixo para entrar:`}
            </p>
            <div style="background:#f4f6f8;border-radius:10px;padding:16px 20px;margin:20px 0">
              <p style="margin:0 0 6px;font-size:13px;color:#64748b">SEUS DADOS DE ACESSO</p>
              <p style="margin:4px 0;font-size:14px"><strong>Email:</strong> ${emailNorm}</p>
              <p style="margin:4px 0;font-size:14px"><strong>Senha temporária:</strong>
                <code style="background:#e2e8f0;padding:2px 8px;border-radius:4px;font-size:15px">${senhaTemp}</code>
              </p>
            </div>
            <a href="${BASE_URL}/portal.html"
               style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-bottom:16px">
              Acessar o Portal →
            </a>
            <p style="color:#64748b;font-size:13px">Ao entrar pela primeira vez, você será solicitado a criar uma nova senha.</p>
          </div>`,
      });
    } catch (e) {
      console.error('Erro ao enviar email:', e);
      return res.status(200).json({ ok: true, emailSent: false, warning: 'Cadastro salvo mas email não enviado: ' + e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    emailSent: gmailConfigured(),
    isNew,
    ...(gmailConfigured() ? {} : { senhaTemp }),
  });
};
