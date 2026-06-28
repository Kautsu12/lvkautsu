// lib/audit.js — log central de alterações (quem fez o quê e quando).
// Guardado no Redis em 'sgi_audit_log' (últimos MAX eventos). Não bloqueia a operação principal.
const { Redis } = require('@upstash/redis');
const URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/^["']|["']$/g, '');
const TOK = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');
const KEY = 'sgi_audit_log';
const MAX = 1000;
function _redis() { return new Redis({ url: URL, token: TOK }); }
async function logEvent(entry) {
  if (!URL || !TOK) return;
  try {
    const redis = _redis();
    const raw = await redis.get(KEY);
    let arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({
      at: new Date().toISOString(),
      byEmail: entry.byEmail || '',
      byNome: entry.byNome || '',
      action: entry.action || '',
      modulo: entry.modulo || '',
      item: entry.item || '',
    });
    if (arr.length > MAX) arr = arr.slice(0, MAX);
    await redis.set(KEY, JSON.stringify(arr));
  } catch (e) { /* silencioso */ }
}
async function readLog(limit) {
  if (!URL || !TOK) return [];
  try {
    const redis = _redis();
    const raw = await redis.get(KEY);
    let arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) arr = [];
    return limit ? arr.slice(0, limit) : arr;
  } catch (e) { return []; }
}
module.exports = { logEvent, readLog };
