// api/load.js — carrega dados do Upstash Redis (vars KV_REST_API_* da Vercel)
const { Redis } = require('@upstash/redis');
const { getSession } = require('../lib/session');

// Aceita os nomes KV_REST_API_* (integração Vercel) OU UPSTASH_REDIS_REST_*
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/^["']|["']$/g, "");
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim().replace(/^["']|["']$/g, "");

// Chaves com dados sensiveis: somente ADM pode ler/gravar.
const SENSITIVE_KEYS = ['password_overrides', 'portal_users', 'sgi_users'];

module.exports = async function handler(req, res) {
  // API interna same-origin: sem CORS curinga.
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
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
  const { key } = req.query;
  // Controle de acesso por papel no servidor: chaves sensiveis só para ADM.
  if (SENSITIVE_KEYS.includes(key) && session.role !== 'ADM') {
    return res.status(403).json({ error: 'Acesso negado a esta informação.' });
  }
  // Aceita as chaves globais OU chaves no padrão "auditoria:<id>" (uma por auditoria)
  // 'terceiros' (base legada) removida: o módulo ativo usa 'terceiros_sgi' via /api/terc.
  // 'mapa_sgi' adicionada (Fase 1 do módulo Mapa de Processos / cadeia de valor).
  const ALLOWED_KEYS = ['auditorias', 'criterios_globais', 'mte_auditorias', 'organograma', 'plano_acao_status', 'programa', 'youtube_channels', 'user_profiles', 'password_overrides', 'documentos_vencimento', 'notifications_log', 'portal_users', 'mapa_sgi'];
  const PER_AUDITORIA = /^auditoria:[A-Za-z0-9_\-]+$/;
  const PER_MTE = /^mte:[A-Za-z0-9_\-]+$/;
  const PER_USER_PREFS = /^user_prefs:[JR]$/;
  if (!key || (!ALLOWED_KEYS.includes(key) && !PER_AUDITORIA.test(key) && !PER_MTE.test(key) && !PER_USER_PREFS.test(key))) {
    return res.status(400).json({ error: 'Chave inválida: ' + key });
  }
  try {
    const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    const raw = await redis.get(key);
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ value: value ?? null });
  } catch (err) {
    console.error('Redis load error:', err); // detalhe fica só no log do servidor
    return res.status(500).json({ error: 'Erro ao carregar dados.' });
  }
};
