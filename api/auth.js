// api/auth.js — autenticação admin (J/R)
// Ações via ?action= : login | logout | whoami | change_password
// Consolida: login.js + logout.js + whoami.js + change_password.js

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Redis } = require('@upstash/redis');
const { logEvent, readLog } = require('../lib/audit');
const { createSession, getSession, destroySession, sessionCookie } = require('../lib/session');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim().replace(/^["']|["']$/g, '');
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');

// ── rate limiting no Redis (eficaz em serverless; o Map em memoria nao era) ──
const MAX_ATT    = 5;
const BLOCK_SEC  = 15 * 60;
const WINDOW_SEC = 10 * 60;

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}
async function checkLimit(ip) {
  try {
    const ttl = await getRedis().ttl('rl_block:' + ip);
    if (ttl && ttl > 0) return { blocked: true, remainingMin: Math.ceil(ttl / 60) };
  } catch (_) {}
  return { blocked: false }; // fail-open em erro de Redis
}
async function registerFail(ip) {
  try {
    const redis = getRedis();
    const k = 'rl_fail:' + ip;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, WINDOW_SEC);
    if (n >= MAX_ATT) { await redis.set('rl_block:' + ip, '1', { ex: BLOCK_SEC }); await redis.del(k); }
    return n;
  } catch (_) { return 0; }
}
async function clearLimit(ip) {
  try { const r = getRedis(); await r.del('rl_fail:' + ip); await r.del('rl_block:' + ip); } catch (_) {}
}

// ── utilitários ─────────────────────────────────────────────────────────────
function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), v.join('=')];
    })
  );
}
// Sessao server-side (Redis). Retorna 'J'/'R' ou null.
async function getUser(req) {
  const s = await getSession(req);
  return s ? (s.user || 'R') : null;
}
function readBody(req) {
  return new Promise(resolve => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (req.body && typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
    }
    let d = '';
    req.on('data', c => { d += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function getRedis() { return new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }
function normAreaResp(raw) {
  const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
  const UNITS = ['TODAS','RESENDE','JOINVILLE','CURITIBA'];
  const keys = Object.keys(obj);
  const looksFlat = keys.length > 0 && keys.every(function(k){ return UNITS.indexOf(String(k).toUpperCase()) !== -1; });
  return looksFlat ? { terceiros: obj } : obj;
}

async function getStoredHash(user) {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const raw = await getRedis().get('password_overrides');
      const ov = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (ov && ov[user]) return ov[user];
    } catch(_) {}
  }
  return process.env['PASSWORD_HASH_' + user] || null;
}

// ── USUÁRIOS / PAPÉIS (controle de acesso) ──────────────────────────────────
const DEFAULT_USERS = {
  'ayrton.ribeiro@galvanizacaoraitz.com.br': { nome: 'Ayrton Ribeiro',    cargo: '', setor: '', unidades: [], role: 'ADM', modules: [] },
  'jucelio.santos@galvanizacaoraitz.com.br': { nome: 'Jucelio F. Santos', cargo: '', setor: '', unidades: [], role: 'SGI', modules: [] },
  'bruna@galvanizacaoraitz.com.br':          { nome: 'Bruna',             cargo: '', setor: '', unidades: [], role: 'SGI', modules: [] },
};
async function getUsers() {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const raw = await getRedis().get('sgi_users');
      const u = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (u && typeof u === 'object' && Object.keys(u).length) {
        const out = {}; for (const k in u) out[String(k).toLowerCase()] = u[k]; return out;
      }
    } catch (_) {}
  }
  return DEFAULT_USERS;
}
async function saveUsers(users) {
  const clean = {}; for (const k in users) clean[String(k).toLowerCase()] = users[k];
  await getRedis().set('sgi_users', JSON.stringify(clean));
}
async function getUserRecord(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const users = await getUsers();
  const rec = users[e];
  // Bootstrap do dono/ADM: garante acesso ADM ao e-mail definido em BOOTSTRAP_ADMIN_EMAIL,
  // mesmo que ainda nao esteja na lista de usuarios (resolve o "primeiro acesso").
  const boot = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim();
  if (boot && e === boot) {
    return Object.assign({ email: e, nome: 'Administrador', cargo: '', setor: '', unidades: [], modules: [] }, rec || {}, { email: e, role: 'ADM' });
  }
  return rec ? { email: e, ...rec } : null;
}
// E-mail do usuario vem da SESSAO no servidor (nao do cookie raitz_email, que era editavel).
async function getCurrentEmail(req) {
  const s = await getSession(req);
  return s && s.email ? String(s.email).toLowerCase() : null;
}
async function currentRecord(req) {
  const s = await getSession(req);
  if (!s) return null;
  // Reconsulta o registro para refletir mudancas de papel/unidade feitas pelo ADM.
  return (s.email && await getUserRecord(s.email)) || (s.role ? { email: s.email, role: s.role, nome: '', unidades: s.unidades || [], modules: s.modules || [] } : null);
}

// ── CALLBACK GOOGLE (OAuth 2.0) — troca code por token, valida dominio, cria sessao ──
async function msCallback(req, res) {
  const fail = (msg) => { res.setHeader('Location', '/login.html?error=' + encodeURIComponent(msg)); res.status(302).end(); };
  try {
    const { code, state } = req.query;
    const cookies = parseCookies(req);
    if (!state || state !== cookies['ms_state']) return fail('Sessao de login invalida. Tente novamente.');
    const cid = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET, sessionSecret = process.env.SESSION_SECRET;
    if (!cid || !secret || !sessionSecret) return fail('Login Google nao configurado.');
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const redirectUri = `${proto}://${req.headers.host}/api/auth`;
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, client_secret: secret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    const tj = await tok.json();
    if (!tok.ok) return fail('Falha no login Google: ' + (tj.error_description || tj.error || 'erro'));
    let email = '';
    if (tj.id_token) {
      try {
        const part = tj.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
        if (payload.email_verified === false) return fail('E-mail Google nao verificado.');
        email = String(payload.email || '').toLowerCase();
      } catch (_) {}
    }
    if (!email && tj.access_token) {
      try {
        const me = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tj.access_token } });
        const mj = await me.json();
        email = String(mj.email || '').toLowerCase();
      } catch (_) {}
    }
    if (!email) return fail('Nao foi possivel obter o e-mail da conta Google.');
    // Acesso controlado pela allowlist de usuarios (qualquer e-mail Google que um ADM tenha liberado).
    const rec = await getUserRecord(email);
    if (!rec) return fail('Seu e-mail nao tem acesso liberado. Solicite ao administrador (ADM).');
    // Cria sessao server-side com papel/unidades vindos do registro (fonte de verdade no servidor).
    const token = await createSession({ user: 'R', email, role: rec.role, unidades: rec.unidades || (rec.unidade ? [rec.unidade] : []), modules: rec.modules || [] });
    res.setHeader('Set-Cookie', [
      sessionCookie(token, 28800),
      `raitz_login_at=${Date.now()}; Secure; SameSite=Lax; Path=/; Max-Age=28800`,
      `raitz_email=${encodeURIComponent(email)}; Secure; SameSite=Lax; Path=/; Max-Age=28800`,
      `ms_state=; HttpOnly; Path=/; Max-Age=0`,
    ]);
    res.setHeader('Location', '/');
    return res.status(302).end();
  } catch (e) {
    return fail('Erro no login: ' + e.message);
  }
}

// ── handler principal ────────────────────────────────────────────────────────
const AJUDA_MANUAL = `Você é a Coruja METIS 🦉, a assistente oficial da Central de Ajuda do Central SGI — o sistema de gestão integrada da marca METIS. Você conhece todo o sistema e ajuda qualquer usuário. Responda SEMPRE em português do Brasil, em tom simples, direto, cordial e um pouquinho acolhedor (você é uma coruja sábia e prestativa, mas sem exageros). Seja conciso: explique o passo a passo de onde clicar. Responda APENAS sobre como usar este sistema. Se perguntarem algo fora do escopo do sistema, diga gentilmente que você só ajuda com o Central SGI e oriente a procurar o administrador (ADM). Nunca invente telas ou botões que não existam no manual abaixo. Se não souber, admita e sugira falar com o administrador.

MANUAL DO SISTEMA (use como única fonte de verdade):

VISÃO GERAL
- O Central SGI é acessado por login com conta Google. Só entram e-mails que um administrador (ADM) autorizou na lista de usuários.
- Papéis de acesso: ADM (administrador, acesso total), SGI (qualidade, acesso amplo), Gestor (gere sua unidade), Usuário (acesso restrito ao que for liberado).
- Unidades: Resende, Joinville e Curitiba. Gestor e Usuário veem só a(s) sua(s) unidade(s). ADM e SGI veem todas e podem focar em uma unidade pelo menu do perfil (canto superior direito).
- Tema claro/escuro: botão de lua/sol no canto inferior direito.

MÓDULOS (menu lateral): Auditoria (subitens "Interna" e "Programa de Auditoria"), Auditorias MTE, Relatórios, Documentos internos (Vencimentos) e Configurações (apenas ADM).

AUDITORIA INTERNA
- No menu, abra "Auditoria" → "Interna". É o módulo de auditorias internas do SGI (não é separado por unidade: todos com acesso veem tudo).
- "Programa de Auditoria" (dentro de Interna) abre o planejamento das auditorias.
- Em cada auditoria você registra os itens, avalia conformidades e acompanha a maturidade e o resultado (aprovado/reprovado).
- RNC (não conformidade): a partir de uma auditoria você emite RNCs; o responsável recebe um link para tratar cada uma.

AUDITORIAS MTE
- No menu, abra "MTE": a lista das auditorias MTE, onde você cria e edita cada uma.

RELATÓRIOS
- No menu, abra "Relatórios": tem as abas "Plano de Ação" (consolidado das ações) e "Dashboard" (indicadores e visão geral do sistema).

DOCUMENTOS INTERNOS · VENCIMENTOS
- Abra "Gestão de documentos internos" → "Vencimentos": cadastre documentos com Tipo, Emissão e Validade e acompanhe o status (Pendente, Regular, A vencer em até 30 dias, Vencido).

CONFIGURAÇÕES (apenas ADM)
- Usuários e acessos: criar/editar usuários e definir papel (ADM, SGI, Gestor, Usuário), unidades e módulos liberados. Há importação por Excel.
- Histórico de alterações: registro de quem inseriu, editou ou removeu o quê.

Se a pessoa pedir algo que dependa de permissão que ela não tem (por exemplo, Configurações é só do ADM), explique isso.`;
async function geminiAjuda(messages) {
  const KEY = (process.env.GEMINI_API_KEY || '').trim();
  if (!KEY) return { ok: false, error: 'A Central de Ajuda ainda nao esta ativa: falta configurar GEMINI_API_KEY no Vercel.' };
  const MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const contents = messages.slice(-12).map(function (m) { return { role: (m.role === 'model' ? 'model' : 'user'), parts: [{ text: String(m.text || '').slice(0, 4000) }] }; });
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length) return { ok: false, error: 'Pergunta vazia' };
  const body = { system_instruction: { parts: [{ text: AJUDA_MANUAL }] }, contents: contents, generationConfig: { temperature: 0.3, maxOutputTokens: 800 } };
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent?key=' + encodeURIComponent(KEY), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) ? j.error.message : ('Erro IA (' + r.status + ')') };
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.map(function (p) { return p.text || ''; }).join('').trim();
    return { ok: true, reply: text || 'Nao consegui gerar uma resposta agora. Tente reformular a pergunta.' };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

module.exports = async function handler(req, res) {
  // API interna same-origin: sem CORS curinga.
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Callback do Google (OAuth) chega em GET /api/auth?code=...
  if (req.method === 'GET' && req.query.code) return msCallback(req, res);

  const action = req.query.action || (req.method === 'GET' ? 'whoami' : 'login');

  // ── LOGIN GOOGLE (OAuth 2.0) ──
  if (action === 'ms-login' || action === 'google-login') {
    const cid = process.env.GOOGLE_CLIENT_ID;
    if (!cid) return res.status(500).send('Login Google nao configurado (defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET).');
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const redirectUri = `${proto}://${req.headers.host}/api/auth`;
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `ms_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    const params = new URLSearchParams({
      client_id: cid, response_type: 'code', redirect_uri: redirectUri,
      scope: 'openid email profile', state,
      access_type: 'online', prompt: 'select_account',
    });
    res.setHeader('Location', `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    return res.status(302).end();
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  if (action === 'login') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    const ip = getIp(req);
    const limit = await checkLimit(ip);
    if (limit.blocked)
      return res.status(429).json({ error: `Muitas tentativas. Tente em ${limit.remainingMin} minuto(s).` });

    const { password, user, email } = await readBody(req);
    if (!password || typeof password !== 'string')
      return res.status(400).json({ error: 'Senha não informada' });
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret)
      return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });

    // Suporta hash bcrypt (novo) e HMAC-SHA256 (legado) para migracao sem travar ninguem.
    const hashEq = async (pw, stored) => {
      if (!stored) return false;
      if (String(stored).startsWith('$2')) {
        try { return await bcrypt.compare(pw, stored); } catch (_) { return false; }
      }
      try {
        const ih = crypto.createHmac('sha256', sessionSecret).update(pw).digest('hex');
        return Buffer.from(ih, 'hex').length === Buffer.from(stored, 'hex').length
          && crypto.timingSafeEqual(Buffer.from(ih, 'hex'), Buffer.from(stored, 'hex'));
      } catch (_) { return false; }
    };

    try {
      const ALLOWED_DOMAIN = '@galvanizacaoraitz.com.br';
      let authUser = null;
      let loginEmail = null;

      if (email) {
        const e = String(email).toLowerCase().trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || !e.endsWith(ALLOWED_DOMAIN))
          return res.status(401).json({ error: 'Use seu e-mail corporativo @galvanizacaoraitz.com.br' });
        loginEmail = e;
        if (!(await getUserRecord(e))) return res.status(403).json({ error: 'Seu e-mail nao tem acesso liberado. Solicite ao administrador.' });
        // senha única: validada contra os acessos existentes (R ou J)
        for (const u of ['R', 'J']) {
          if (await hashEq(password, await getStoredHash(u))) { authUser = u; break; }
        }
      } else {
        if (!user || !['J','R'].includes(user))
          return res.status(400).json({ error: 'Usuário inválido' });
        if (await hashEq(password, await getStoredHash(user))) authUser = user;
      }

      if (authUser) {
        await clearLimit(ip);
        // Migracao transparente: se o hash atual e' legado (HMAC), regrava como bcrypt.
        try {
          const cur = await getStoredHash(authUser);
          if (cur && !String(cur).startsWith('$2') && REDIS_URL && REDIS_TOKEN) {
            const redis = getRedis();
            const raw = await redis.get('password_overrides');
            const ov = (raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}) || {};
            ov[authUser] = await bcrypt.hash(password, 10);
            await redis.set('password_overrides', JSON.stringify(ov));
          }
        } catch (_) {}
        const rec = loginEmail ? await getUserRecord(loginEmail) : null;
        const token = await createSession({ user: authUser, email: loginEmail || '', role: rec ? rec.role : null, unidades: rec ? (rec.unidades || (rec.unidade ? [rec.unidade] : [])) : [], modules: rec ? (rec.modules || []) : [] });
        const cookies = [
          sessionCookie(token, 28800),
          `raitz_login_at=${Date.now()}; Secure; SameSite=Lax; Path=/; Max-Age=28800`,
        ];
        if (loginEmail) cookies.push(`raitz_email=${encodeURIComponent(loginEmail)}; Secure; SameSite=Lax; Path=/; Max-Age=28800`);
        res.setHeader('Set-Cookie', cookies);
        return res.status(200).json({ success: true, user: authUser });
      }
      const count = await registerFail(ip);
      const remaining = MAX_ATT - count;
      return res.status(401).json({
        error: remaining > 0
          ? `Senha incorreta. ${remaining} tentativa(s) restante(s).`
          : 'Conta bloqueada por 15 minutos.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'Erro interno: ' + err.message });
    }
  }

  // ── LOGOUT ─────────────────────────────────────────────────────────────────
  if (action === 'logout') {
    await destroySession(req); // remove a sessao do Redis (revogacao real)
    res.setHeader('Set-Cookie', [
      'raitz_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'raitz_email=; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'raitz_login_at=; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
    // GET direto (window.location.href) → redireciona
    if (req.method === 'GET') {
      res.setHeader('Location', '/login.html');
      return res.status(302).end();
    }
    // fetch() → JSON
    return res.status(200).json({ ok: true });
  }

  // ── WHOAMI ─────────────────────────────────────────────────────────────────
  if (action === 'whoami') {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });

    const loginAt = parseInt(parseCookies(req)['raitz_login_at'] || '0', 10) || null;
    let profile = { displayName: 'Central SGI - ' + user, color: user === 'J' ? '#7c3aed' : '#1565c0', initial: user };

    if (REDIS_URL && REDIS_TOKEN) {
      try {
        const raw = await getRedis().get('user_profiles');
        const profs = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (profs && profs[user]) Object.assign(profile, profs[user]);
      } catch(_) {}
    }
    const cEmail = await getCurrentEmail(req);
    const rec = cEmail ? await getUserRecord(cEmail) : null;
    return res.status(200).json({
      user, email: cEmail, profile, loginAt,
      role: rec ? rec.role : null,
      nome: rec ? (rec.nome || '') : '',
      cargo: rec ? (rec.cargo || '') : '',
      setor: rec ? (rec.setor || '') : '',
      unidades: rec ? (rec.unidades || (rec.unidade ? [rec.unidade] : [])) : [],
      modules: rec ? (rec.modules || []) : [],
      isAdm: !!(rec && rec.role === 'ADM'),
    });
  }

  if (action === 'ajuda') {
    if (!(await getUser(req))) return res.status(401).json({ ok: false, error: 'Nao autenticado' });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Metodo nao permitido' });
    const b = await readBody(req);
    const messages = Array.isArray(b.messages) ? b.messages : (b.question ? [{ role: 'user', text: b.question }] : []);
    if (!messages.length) return res.status(400).json({ ok: false, error: 'Pergunta vazia' });
    const out = await geminiAjuda(messages);
    return res.status(200).json(out);
  }

  // ── USUÁRIOS (gestão de acessos) — somente ADM ──────────────────────────────
  if (action === 'users' || action === 'user-save' || action === 'user-delete' || action === 'users-import' || action === 'audit-log' || action === 'area-resp-get' || action === 'area-resp-save') {
    if (!(await getUser(req))) return res.status(401).json({ error: 'Não autenticado' });
    const me = await currentRecord(req);
    if (!me || me.role !== 'ADM') return res.status(403).json({ error: 'Apenas o administrador (ADM) pode gerenciar usuários.' });
    const VALID_ROLES = ['ADM','SGI','Gestor','Usuario'];

    if (action === 'users') {
      const users = await getUsers();
      const list = Object.keys(users).map(e => ({ email: e, nome: users[e].nome || '', cargo: users[e].cargo || '', setor: users[e].setor || '', unidades: users[e].unidades || (users[e].unidade ? [users[e].unidade] : []), role: users[e].role || 'Usuario', modules: users[e].modules || [] }));
      return res.status(200).json({ ok: true, users: list, me: me.email });
    }
    if (action === 'user-save') {
      const b = await readBody(req);
      const email = String(b.email || '').toLowerCase().trim();
      if (!email.endsWith('@galvanizacaoraitz.com.br')) return res.status(400).json({ error: 'E-mail deve ser @galvanizacaoraitz.com.br' });
      const role = VALID_ROLES.includes(b.role) ? b.role : 'Usuario';
      const users = await getUsers();
      const next = {}; for (const k in users) next[k] = users[k];
      const _wasNew = !users[email];
      next[email] = { nome: String(b.nome || '').trim(), cargo: String(b.cargo || '').trim(), setor: String(b.setor || '').trim(), unidades: Array.isArray(b.unidades) ? b.unidades.map(u => String(u).toUpperCase()) : [], role, modules: Array.isArray(b.modules) ? b.modules : [] };
      await saveUsers(next);
      await logEvent({ byEmail: me.email, byNome: me.nome, action: _wasNew ? 'Criou usuário' : 'Editou usuário', modulo: 'Acessos', item: (next[email].nome || email) + ' · ' + role });
      return res.status(200).json({ ok: true });
    }
    if (action === 'user-delete') {
      const b = await readBody(req);
      const email = String(b.email || '').toLowerCase().trim();
      if (email === me.email) return res.status(400).json({ error: 'Você não pode remover o seu próprio acesso.' });
      const users = await getUsers();
      const next = {}; for (const k in users) if (k !== email) next[k] = users[k];
      if (Object.values(next).filter(u => u.role === 'ADM').length < 1) return res.status(400).json({ error: 'Precisa existir ao menos um ADM.' });
      await saveUsers(next);
      await logEvent({ byEmail: me.email, byNome: me.nome, action: 'Removeu usuário', modulo: 'Acessos', item: email });
      return res.status(200).json({ ok: true });
    }
    if (action === 'users-import') {
      const b = await readBody(req);
      const arr = Array.isArray(b.users) ? b.users : [];
      const users = await getUsers();
      const next = {}; for (const k in users) next[k] = users[k];
      let imported = 0, skipped = 0;
      for (const u of arr) {
        const email = String(u.email || '').toLowerCase().trim();
        if (!email.endsWith('@galvanizacaoraitz.com.br')) { skipped++; continue; }
        const ex = next[email];
        next[email] = {
          nome: String(u.nome || '').trim() || (ex ? ex.nome : ''),
          cargo: String(u.cargo || '').trim() || (ex ? ex.cargo : ''),
          setor: String(u.setor || '').trim() || (ex ? (ex.setor || '') : ''),
          unidades: (String(u.unidade || '').trim() ? String(u.unidade).split(/[,;/]+/).map(x => x.trim().toUpperCase()).filter(Boolean) : (ex ? (ex.unidades || []) : [])),
          role: ex ? ex.role : 'Usuario',
          modules: ex ? (ex.modules || []) : [],
        };
        imported++;
      }
      await saveUsers(next);
      await logEvent({ byEmail: me.email, byNome: me.nome, action: 'Importou usuários', modulo: 'Acessos', item: imported + ' importado(s), ' + skipped + ' ignorado(s)' });
      return res.status(200).json({ ok: true, imported, skipped });
    }
    if (action === 'audit-log') {
      const limit = parseInt(req.query.limit || '300', 10) || 300;
      return res.status(200).json({ ok: true, log: await readLog(limit) });
    }
    if (action === 'area-resp-get') {
      const modulo = String((req.query && req.query.modulo) || 'terceiros');
      let all = {};
      try { all = normAreaResp(await getRedis().get('area_responsaveis')); } catch (_) {}
      return res.status(200).json({ ok: true, modulo, mapa: all[modulo] || {} });
    }
    if (action === 'area-resp-save') {
      const b = await readBody(req);
      const inMapa = (b && b.mapa && typeof b.mapa === 'object') ? b.mapa : {};
      const clean = {};
      for (const un of Object.keys(inMapa)) {
        const U = String(un || '').toUpperCase();
        const areas = inMapa[un] || {};
        const ca = {};
        for (const ar of Object.keys(areas)) {
          let list = areas[ar];
          if (typeof list === 'string') list = list.split(/[,;\s]+/);
          if (!Array.isArray(list)) list = [];
          const emails = list.map(function (x) { return String(x || '').toLowerCase().trim(); }).filter(function (x) { return x.indexOf('@') !== -1; });
          if (emails.length) ca[ar] = Array.from(new Set(emails));
        }
        clean[U] = ca;
      }
      const modulo = String((b && b.modulo) || 'terceiros');
      let all = {};
      try { all = normAreaResp(await getRedis().get('area_responsaveis')); } catch (_) {}
      all[modulo] = clean;
      await getRedis().set('area_responsaveis', JSON.stringify(all));
      await logEvent({ byEmail: me.email, byNome: me.nome, action: 'Atualizou responsáveis por área', modulo: 'Acessos', item: modulo + ': ' + Object.keys(clean).join(', ') });
      return res.status(200).json({ ok: true });
    }
  }

  // ── CHANGE PASSWORD ─────────────────────────────────────────────────────────
  if (action === 'change_password') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) return res.status(500).json({ error: 'CONFIG: SESSION_SECRET' });

    const { currentPassword, newPassword } = await readBody(req);
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Faltando senha atual ou nova' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Nova senha deve ter no mínimo 8 caracteres' });

    const storedHash = await getStoredHash(user);
    if (!storedHash) return res.status(500).json({ error: 'CONFIG: senha não definida' });

    // Verifica a senha atual aceitando bcrypt (novo) ou HMAC-SHA256 (legado).
    let match = false;
    if (String(storedHash).startsWith('$2')) {
      try { match = await bcrypt.compare(currentPassword, storedHash); } catch(_) {}
    } else {
      try {
        const inputHash = crypto.createHmac('sha256', sessionSecret).update(currentPassword).digest('hex');
        match = Buffer.from(inputHash,'hex').length === Buffer.from(storedHash,'hex').length
          && crypto.timingSafeEqual(Buffer.from(inputHash,'hex'), Buffer.from(storedHash,'hex'));
      } catch(_) {}
    }
    if (!match) return res.status(401).json({ error: 'Senha atual incorreta' });

    const newHash = await bcrypt.hash(newPassword, 10); // bcrypt em vez de HMAC
    if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis não configurado' });

    try {
      const redis = getRedis();
      const raw = await redis.get('password_overrides');
      const overrides = (raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}) || {};
      overrides[user] = newHash;
      await redis.set('password_overrides', JSON.stringify(overrides));
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: 'Falha ao salvar: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
