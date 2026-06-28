// api/portal-auth.js
// Ações: login | logout | whoami | reset-password
// Sessão armazenada em Redis: portal_session:{token} → {email, terceiroId, userId}  (TTL 24h)
// Usuários: portal_users → { [email]: {id, passwordHash, mustResetPassword, terceiroId, terceiroNome} }

const { Redis } = require('@upstash/redis');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const SESSION_TTL = 60 * 60 * 24; // 24 horas

function getRedis() { return new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }

// ── Anti força-bruta no Redis (por IP+e-mail; eficaz em serverless) ──
const _MAX_ATT = 6, _BLOCK_SEC = 15 * 60, _WIN_SEC = 10 * 60;
function _clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'; }
async function _blockedMin(redis, key) {
  try { const ttl = await redis.ttl('prl_block:' + key); if (ttl && ttl > 0) return Math.ceil(ttl / 60); } catch (_) {}
  return 0;
}
async function _registerFail(redis, key) {
  try {
    const k = 'prl_fail:' + key;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, _WIN_SEC);
    if (n >= _MAX_ATT) { await redis.set('prl_block:' + key, '1', { ex: _BLOCK_SEC }); await redis.del(k); }
  } catch (_) {}
}
async function _clearAtt(redis, key) {
  try { await redis.del('prl_fail:' + key); await redis.del('prl_block:' + key); } catch (_) {}
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), v.join('=')];
    })
  );
}

async function getPortalSession(req) {
  const token = parseCookies(req)['portal_session'];
  if (!token) return null;
  const redis = getRedis();
  const data = await redis.get(`portal_session:${token}`);
  return data || null;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.body && typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.method === 'GET' ? 'whoami' : 'login');
  const redis = getRedis();

  // ── WHOAMI ──────────────────────────────────────────────────
  if (action === 'whoami') {
    const session = await getPortalSession(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Não autenticado' });
    const users = (await redis.get('portal_users')) || {};
    const user = users[session.email];
    if (!user) return res.status(401).json({ ok: false, error: 'Usuário não encontrado' });
    return res.status(200).json({
      ok: true,
      email: session.email,
      terceiroId: session.terceiroId,
      terceiroNome: user.terceiroNome || '',
      mustResetPassword: user.mustResetPassword === true,
    });
  }

  // ── LOGIN ────────────────────────────────────────────────────
  if (action === 'login') {
    const { email, password } = await readBody(req);
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email e senha obrigatórios' });

    const emailNorm = String(email).toLowerCase().trim();
    const attKey = _clientIp(req) + '|' + emailNorm;
    const blockedMin = await _blockedMin(redis, attKey);
    if (blockedMin) return res.status(429).json({ ok: false, error: `Muitas tentativas. Tente novamente em ${blockedMin} minuto(s).` });

    const users = (await redis.get('portal_users')) || {};
    const user = users[emailNorm];
    if (!user) { await _registerFail(redis, attKey); return res.status(401).json({ ok: false, error: 'Email ou senha incorretos' }); }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) { await _registerFail(redis, attKey); return res.status(401).json({ ok: false, error: 'Email ou senha incorretos' }); }

    await _clearAtt(redis, attKey);
    const token = crypto.randomBytes(32).toString('hex');
    await redis.set(`portal_session:${token}`, {
      email: emailNorm,
      terceiroId: user.terceiroId,
      userId: user.id,
    }, { ex: SESSION_TTL });

    res.setHeader('Set-Cookie', `portal_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`);
    return res.status(200).json({
      ok: true,
      mustResetPassword: user.mustResetPassword === true,
      terceiroId: user.terceiroId,
      terceiroNome: user.terceiroNome || '',
    });
  }

  // ── LOGOUT ───────────────────────────────────────────────────
  if (action === 'logout') {
    const token = parseCookies(req)['portal_session'];
    if (token) await redis.del(`portal_session:${token}`);
    res.setHeader('Set-Cookie', 'portal_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res.status(200).json({ ok: true });
  }

  // ── RESET PASSWORD ───────────────────────────────────────────
  if (action === 'reset-password') {
    const session = await getPortalSession(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Não autenticado' });

    const { currentPassword, newPassword } = await readBody(req);
    if (!currentPassword || !newPassword)
      return res.status(400).json({ ok: false, error: 'Campos obrigatórios ausentes' });
    if (newPassword.length < 8)
      return res.status(400).json({ ok: false, error: 'A nova senha deve ter ao menos 8 caracteres' });

    const users = (await redis.get('portal_users')) || {};
    const user = users[session.email];
    if (!user) return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(401).json({ ok: false, error: 'Senha atual incorreta' });

    users[session.email].passwordHash = await bcrypt.hash(newPassword, 10);
    users[session.email].mustResetPassword = false;
    await redis.set('portal_users', users);

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ ok: false, error: 'Ação inválida' });
};
