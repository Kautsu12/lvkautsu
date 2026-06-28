// lib/session.js — sessão interna (admin J/R) armazenada no Redis (server-side)
// Substitui o antigo cookie "raitz_session = SESSION_SECRET:user" (segredo estatico
// compartilhado) por um TOKEN ALEATORIO por login, guardado no Redis com TTL.
// O papel (role), e-mail e unidades ficam no SERVIDOR — nunca dependem de cookie editavel.
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim().replace(/^["']|["']$/g, '');
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');

const SESSION_TTL = 60 * 60 * 8; // 8 horas
const PREFIX = 'sgi_session:';

function getRedis() { return new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map(c => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    })
  );
}

// Cria sessao e devolve o token aleatorio (vai no cookie)
async function createSession(data) {
  const token = crypto.randomBytes(32).toString('hex');
  const payload = {
    user:     data.user || 'R',
    email:    String(data.email || '').toLowerCase(),
    role:     data.role || null,
    unidades: Array.isArray(data.unidades) ? data.unidades : [],
    modules:  Array.isArray(data.modules) ? data.modules : [],
    loginAt:  Date.now(),
  };
  await getRedis().set(PREFIX + token, payload, { ex: SESSION_TTL });
  return token;
}

// Le a sessao a partir do cookie. Rejeita o formato antigo (contendo ':').
async function getSession(req) {
  const token = parseCookies(req)['raitz_session'] || '';
  if (!token || token.indexOf(':') !== -1) return null; // formato antigo -> invalido
  try {
    const s = await getRedis().get(PREFIX + token);
    return s || null;
  } catch (_) { return null; }
}

async function destroySession(req) {
  const token = parseCookies(req)['raitz_session'] || '';
  if (token && token.indexOf(':') === -1) {
    try { await getRedis().del(PREFIX + token); } catch (_) {}
  }
}

function sessionCookie(token, maxAge) {
  const age = maxAge == null ? SESSION_TTL : maxAge;
  return `raitz_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
}

module.exports = { createSession, getSession, destroySession, sessionCookie, parseCookies, SESSION_TTL };
