// api/save.js — salva E carrega dados do Upstash Redis (vars KV_REST_API_* da Vercel).
// O antigo /api/load foi consolidado aqui (limite de 12 funcoes do plano Hobby da Vercel):
// o rewrite "/api/load" -> "/api/save?op=load" no vercel.json mantem a URL antiga funcionando.
//   GET  ?op=load&key=<chave>  -> carrega (mesmas regras do antigo load.js)
//   POST {key, value}          -> salva
const { Redis } = require('@upstash/redis');
const { getSession } = require('../lib/session');

// Aceita os nomes KV_REST_API_* (integração Vercel) OU UPSTASH_REDIS_REST_*
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/^["']|["']$/g, "");
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim().replace(/^["']|["']$/g, "");

// Chaves com dados sensiveis: somente ADM pode ler/gravar.
// 'cincos_campo' = cofre dos links de acesso de campo do modulo 5S (tokens + aparelho amarrado).
const SENSITIVE_KEYS = ['password_overrides', 'portal_users', 'sgi_users', 'cincos_campo'];

// Aceita as chaves globais OU chaves no padrão "auditoria:<id>" (uma por auditoria)
// 'terceiros' (base legada) removida: o módulo ativo usa 'terceiros_sgi' via /api/terc.
// 'mapa_sgi' adicionada (Fase 1 do módulo Mapa de Processos / cadeia de valor).
// Modulo 5S: 'cincos_unidades' (cadastro de unidades), 'cincos_matriz' (regua 0-5) e
// 'cincos_campo' (cofre de links) sao globais; setores/index/ronda carregam a UNIDADE
// na propria chave (isolamento por unidade validado no servidor).
const ALLOWED_KEYS = ['auditorias', 'criterios_globais', 'mte_auditorias', 'organograma', 'plano_acao_status', 'programa', 'youtube_channels', 'user_profiles', 'password_overrides', 'documentos_vencimento', 'notifications_log', 'portal_users', 'mapa_sgi', 'cincos_unidades', 'cincos_matriz', 'cincos_campo'];
const PER_AUDITORIA = /^auditoria:[A-Za-z0-9_\-]+$/;
const PER_MTE = /^mte:[A-Za-z0-9_\-]+$/;
const PER_USER_PREFS = /^user_prefs:[JR]$/;

// ── Modulo 5S: chaves por unidade ──────────────────────────────────────────
// A unidade fica no segmento apos o prefixo. Aceita qualquer caractere menos ':'
// (nomes com espaco/acento sao validos); o id da ronda usa charset seguro.
const PER_CINCOS_SETORES = /^cincos_setores:[^:]+$/;        // cadastro de setores da unidade (grava: ADM)
const PER_CINCOS_INDEX   = /^cincos_index:[^:]+$/;          // indice de rondas da unidade
const PER_CINCOS_RONDA   = /^cincos:[^:]+:[A-Za-z0-9_\-]+$/; // uma ronda: cincos:<unidade>:<id>

// Papeis do sistema (ver api/auth.js VALID_ROLES): ADM, SGI, Gestor, Usuario (+ CAMPO_5S do link).
// ADM e SGI enxergam todas as unidades; Gestor/Usuario so as suas (session.unidades).
function seesAllUnits(session) { return session.role === 'ADM' || session.role === 'SGI'; }
function unidadePermitida(session, unidade) {
  if (seesAllUnits(session)) return true;
  return Array.isArray(session.unidades) && session.unidades.includes(unidade);
}
// Quem pode LANCAR ronda (gravar index/ronda). Usuario e' somente-leitura. CAMPO_5S so na sua unidade.
const WRITE_ROLES = ['ADM', 'SGI', 'Gestor', 'CAMPO_5S'];

// Extrai a unidade de uma chave 5S (null para chaves globais: matriz/unidades).
function cincosUnidade(key) {
  if (key === 'cincos_matriz' || key === 'cincos_unidades') return null;
  const i = key.indexOf(':');
  if (i === -1) return null;
  return key.slice(i + 1).split(':')[0];
}

function keyAllowed(key) {
  return key && (ALLOWED_KEYS.includes(key) || PER_AUDITORIA.test(key) || PER_MTE.test(key) || PER_USER_PREFS.test(key)
    || PER_CINCOS_SETORES.test(key) || PER_CINCOS_INDEX.test(key) || PER_CINCOS_RONDA.test(key));
}

// Regras de acesso do modulo 5S + portao rigido do perfil de campo (CAMPO_5S).
// Retorna null se liberado, ou { code, msg } para bloquear.
function guard5S(session, key, isWrite) {
  const isRonda    = PER_CINCOS_RONDA.test(key);
  const isIndex    = PER_CINCOS_INDEX.test(key);
  const isSetores  = PER_CINCOS_SETORES.test(key);
  const isMatriz   = key === 'cincos_matriz';
  const isUnidades = key === 'cincos_unidades';
  const isCincos   = isRonda || isIndex || isSetores || isMatriz || isUnidades;
  const campo = session.role === 'CAMPO_5S'; // sessao do link de campo (escopo minimo)

  if (campo) {
    // Campo so acessa dados do 5S da SUA unidade: matriz(leitura), setores(leitura),
    // index e ronda(leitura/escrita). Nunca o cadastro de unidades, o cofre de links
    // (cincos_campo cai em SENSITIVE_KEYS -> ja bloqueado) nem qualquer outro modulo.
    if (!(isMatriz || isSetores || isIndex || isRonda)) return { code: 403, msg: 'Acesso negado.' };
    if ((isMatriz || isSetores) && isWrite) return { code: 403, msg: 'Somente leitura.' };
  }

  if (isCincos) {
    const u = cincosUnidade(key);
    if (u !== null && !unidadePermitida(session, u)) {
      return { code: 403, msg: 'Unidade fora do seu acesso.' };
    }
    if (isWrite) {
      // Cadastro de unidades, cadastro de setores e edicao da matriz: somente ADM.
      if ((isUnidades || isSetores || isMatriz) && session.role !== 'ADM') {
        return { code: 403, msg: 'Apenas ADM pode alterar unidades/setores/matriz.' };
      }
      // Lancar/alterar ronda e indice: papeis de escrita (Usuario e' somente-leitura).
      if ((isIndex || isRonda) && !WRITE_ROLES.includes(session.role)) {
        return { code: 403, msg: 'Seu perfil pode apenas visualizar as rondas.' };
      }
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (req.body && typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
    }
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  // API interna same-origin: sem CORS curinga.
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REDIS_URL) {
    return res.status(500).json({ error: 'CONFIG: KV_REST_API_URL (ou UPSTASH_REDIS_REST_URL) não definida' });
  }
  if (!REDIS_TOKEN) {
    return res.status(500).json({ error: 'CONFIG: KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_TOKEN) não definida' });
  }
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'CONFIG: SESSION_SECRET não definida' });
  }
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });

  // ── modo LOAD (antigo /api/load, via rewrite ?op=load) ──
  if (req.query && req.query.op === 'load') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
    const { key } = req.query;
    if (SENSITIVE_KEYS.includes(key) && session.role !== 'ADM') {
      return res.status(403).json({ error: 'Acesso negado a esta informação.' });
    }
    if (!keyAllowed(key)) {
      return res.status(400).json({ error: 'Chave inválida: ' + key });
    }
    const g = guard5S(session, key, false);
    if (g) return res.status(g.code).json({ error: g.msg });
    try {
      const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
      const raw = await redis.get(key);
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.status(200).json({ value: value ?? null });
    } catch (err) {
      console.error('Redis load error:', err); // detalhe fica só no log do servidor
      return res.status(500).json({ error: 'Erro ao carregar dados.' });
    }
  }

  // ── modo SAVE ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  const body = await readBody(req);
  const { key, value } = body;
  // Controle de acesso por papel no servidor: chaves sensiveis só para ADM.
  if (SENSITIVE_KEYS.includes(key) && session.role !== 'ADM') {
    return res.status(403).json({ error: 'Acesso negado a esta operação.' });
  }
  if (!keyAllowed(key)) {
    return res.status(400).json({ error: 'Chave inválida: ' + key });
  }
  const g = guard5S(session, key, true);
  if (g) return res.status(g.code).json({ error: g.msg });
  try {
    const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    await redis.set(key, JSON.stringify(value));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Redis save error:', err); // detalhe fica só no log do servidor
    return res.status(500).json({ error: 'Erro ao salvar dados.' });
  }
};
