// api/portal-docs.js
// GET  → terceiro da sessão (base 'terceiros_sgi') + documentos da empresa + colaboradores (Mão de Obra)
// POST → ações (escopo travado ao terceiro da sessão):
//   updateDoc        {docId, validade?, file?, fileName?}             → doc da empresa
//   addWorker        {nome, cpf?, funcao?}                            → cria colaborador + gera docs da matriz
//   updateWorkerDoc  {workerId, docId, validade?, file?, fileName?}   → doc de um colaborador
//   removeWorker     {workerId}
const { Redis } = require('@upstash/redis');
const { logEvent } = require('../lib/audit');

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const STORE_KEY = 'terceiros_sgi';

// ── Matriz Mão de Obra (espelha terceiros.html) ──
const MMO = [
  ["Relação de empregados alocados","n","n","s","na","s","na","s","na","na","Mensal"],
  ["Comprovante vínculo empregatício","n","n","s","na","s","na","s","na","na","Admissão/alteração"],
  ["ASO vigente","n","s","s","s","s","s","s","s","c","Vencimento"],
  ["Ficha de EPI","n","c","c","c","s","s","s","s","c","Atualização"],
  ["Ordem de Serviço (OS)","n","c","c","c","s","s","s","s","na","Revisão"],
  ["Certificados NR Aplicáveis","n","c","c","c","s","s","s","s","c","Vencimento"],
  ["Cursos Operacionais (Função)","n","c","c","c","s","s","s","s","c","Vencimento"],
  ["Integração SST Presencial","n","n","c","c","s","s","s","s","c","Anual"],
  ["Evidência Treinamento PAE/Emergência","n","n","n","n","c","c","s","s","c","Anual"],
  ["Autorização Atividade Crítica","n","n","n","n","c","c","s","s","na","Vencimento"],
  ["CRF FGTS","s","na","s","na","s","na","s","na","na","Mensal"],
  ["GFIP/GPS","s","na","s","na","s","na","s","na","na","Mensal"],
  ["E-Social","s","na","s","na","s","na","s","na","na","Admissão/alteração"],
];
const COLMAP = { MINIMO:{ltda:1,mei:2}, BAIXO:{ltda:3,mei:4}, MEDIO:{ltda:5,mei:6}, CRITICO:{ltda:7,mei:8} };
const colIdx = (crit, nat) => ((COLMAP[crit] || {})[nat === 'mei' ? 'mei' : 'ltda']) || 1;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function genWorkerDocs(t) {
  const ci = colIdx(t.criticidade, t.natJur);
  return MMO.map(r => {
    const v = r[ci];
    if (v === 'n' || v === 'na') return null;
    return { id: uid(), nome: r[0], freq: r[10], req: v, emissao: '', validade: '' };
  }).filter(Boolean);
}

function getRedis() { return new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }
function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), v.join('=')];
    })
  );
}
async function getPortalSession(req, redis) {
  const token = parseCookies(req)['portal_session'];
  if (!token) return null;
  return await redis.get(`portal_session:${token}`);
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
async function loadState(redis) {
  const raw = await redis.get(STORE_KEY);
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (v && Array.isArray(v.terceiros)) ? v : { terceiros: [], workers: [], logs: [] };
}
const slimDoc = d => ({ id: d.id, nome: d.nome, area: d.area, freq: d.freq, emissao: d.emissao, validade: d.validade, file: d.file, fileName: d.fileName, req: d.req, aprov: d.aprov || '', aprovMotivo: d.aprovMotivo || '' });
const slimWorker = w => ({ id: w.id, nome: w.nome, cpf: w.cpf, funcao: w.funcao, wdocs: (w.wdocs || []).map(slimDoc) });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  const session = await getPortalSession(req, redis);
  if (!session) return res.status(401).json({ ok: false, error: 'Não autenticado' });
  const { terceiroId } = session;

  if (req.method === 'GET') {
    const state = await loadState(redis);
    const t = (state.terceiros || []).find(x => x.id === terceiroId);
    if (!t) return res.status(200).json({ ok: true, terceiro: null, docs: [], workers: [] });
    const workers = (state.workers || []).filter(w => w.tid === terceiroId).map(slimWorker);
    return res.status(200).json({
      ok: true,
      terceiro: { id: t.id, razaoSocial: t.razaoSocial, fantasia: t.fantasia, cnpj: t.cnpj, unidade: t.unidade, criticidade: t.criticidade },
      docs: (t.docs || []).map(slimDoc),
      workers,
    });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const action = body.action || 'updateDoc';
    const state = await loadState(redis);
    const t = (state.terceiros || []).find(x => x.id === terceiroId);
    if (!t) return res.status(404).json({ ok: false, error: 'Terceiro não encontrado' });
    if (!Array.isArray(state.workers)) state.workers = [];

    if (action === 'updateDoc') {
      const { docId, emissao, validade, file, fileName } = body;
      if (!docId) return res.status(400).json({ ok: false, error: 'docId obrigatório' });
      const doc = (t.docs || []).find(d => d.id === docId);
      if (!doc) return res.status(404).json({ ok: false, error: 'Documento não encontrado' });
      if (emissao !== undefined) doc.emissao = emissao;
      if (validade !== undefined) doc.validade = validade;
      if (file !== undefined) { doc.file = file; doc.fileName = fileName || doc.fileName || ''; doc.uploadedByPortal = true; doc.uploadedAt = new Date().toISOString(); doc.aprov = 'pendente'; doc.aprovMotivo = ''; doc.aprovEm = null; }
      await redis.set(STORE_KEY, JSON.stringify(state));
      if (file !== undefined) await logEvent({ byEmail: session.email, action: 'Anexou documento (portal) — aguardando validação', modulo: 'Portal/Terceiros', item: (doc.nome || docId) + ' — ' + (t.razaoSocial || '') });
      return res.status(200).json({ ok: true });
    }

    if (action === 'addWorker') {
      const nome = (body.nome || '').trim();
      if (!nome) return res.status(400).json({ ok: false, error: 'Nome obrigatório' });
      const w = { id: uid(), tid: terceiroId, nome, cpf: (body.cpf || '').trim(), funcao: (body.funcao || '').trim(), criadoEm: new Date().toISOString(), createdByPortal: true, wdocs: genWorkerDocs(t) };
      state.workers.push(w);
      await redis.set(STORE_KEY, JSON.stringify(state));
      await logEvent({ byEmail: session.email, action: 'Cadastrou colaborador (portal)', modulo: 'Portal/Terceiros', item: (w.nome || '') + ' — ' + (t.razaoSocial || '') });
      return res.status(200).json({ ok: true, worker: slimWorker(w) });
    }

    if (action === 'updateWorkerDoc') {
      const { workerId, docId, emissao, validade, file, fileName } = body;
      const w = state.workers.find(x => x.id === workerId && x.tid === terceiroId);
      if (!w) return res.status(404).json({ ok: false, error: 'Colaborador não encontrado' });
      const doc = (w.wdocs || []).find(d => d.id === docId);
      if (!doc) return res.status(404).json({ ok: false, error: 'Documento não encontrado' });
      if (emissao !== undefined) doc.emissao = emissao;
      if (validade !== undefined) doc.validade = validade;
      if (file !== undefined) { doc.file = file; doc.fileName = fileName || doc.fileName || ''; doc.uploadedByPortal = true; doc.uploadedAt = new Date().toISOString(); doc.aprov = 'pendente'; doc.aprovMotivo = ''; doc.aprovEm = null; }
      await redis.set(STORE_KEY, JSON.stringify(state));
      if (file !== undefined) await logEvent({ byEmail: session.email, action: 'Anexou documento de colaborador (portal) — aguardando validação', modulo: 'Portal/Terceiros', item: (doc.nome || docId) + ' — ' + (w.nome || '') });
      return res.status(200).json({ ok: true });
    }

    if (action === 'removeWorker') {
      // Exclusão de colaborador não é permitida pelo portal do fornecedor (apenas o admin remove).
      return res.status(403).json({ ok: false, error: 'Exclusão de colaborador não permitida' });
    }

    return res.status(400).json({ ok: false, error: 'Ação inválida' });
  }

  return res.status(405).json({ ok: false, error: 'Método não permitido' });
};
