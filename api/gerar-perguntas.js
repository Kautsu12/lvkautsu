// api/gerar-perguntas.js — gera, por IA (Gemini), perguntas de auditoria + documentos + como verificar
// para cada requisito de um processo, usando a IP e a MCR daquele processo como contexto.
const { getSession } = require('../lib/session');

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (req.body && typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); } }
    let data = '';
    req.on('data', c => { data += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const SYS = `Você é um auditor interno sênior de Sistema de Gestão Integrado (ISO 9001, ISO 14001, ISO 45001) de uma empresa de galvanização a fogo.
Tarefa: para cada item de norma informado, elaborar de 2 a 4 perguntas de auditoria fluidas e específicas para ESTE processo, mais uma lista curta de documentos/evidências sugeridas e uma orientação de como verificar.

Como pensar:
- Use a Interação de Processo (IP) e a Matriz de Riscos (MCR) apenas como CONTEXTO, para entender como o processo funciona, o que controla e onde pode falhar. NÃO transforme entradas/saídas em perguntas literais, nem cite "entrada X / saída Y".
- As perguntas devem soar como um auditor experiente conversando: abertas, verificando conformidade E eficácia, ancoradas na realidade do processo (métodos, controles e riscos que aparecem no contexto), sem jargão desnecessário.
- Priorize verificar as barreiras dos riscos de classe mais alta desse processo, quando forem pertinentes ao item da norma.
- "documentos": saem dos métodos da IP e das barreiras da MCR (POP, FIT, registros, indicadores…).
- "comoVerificar": orientação curta e prática de como o auditor busca a evidência (amostragem, observação em campo, cruzar registros), coerente com este processo.
- Se um item não tiver risco/método diretamente ligado no contexto, formule a partir da intenção da cláusula, ainda assim adaptada ao processo.
- Português do Brasil. Responda SOMENTE com o JSON pedido, sem texto fora dele.

Formato de saída (obrigatório):
{ "requisitos": [ { "norma": "...", "codigo": "...", "perguntas": ["...","..."], "documentos": ["...","..."], "comoVerificar": "..." } ] }`;

function txt(v) { return String(v == null ? '' : v); }
function lista(a) { return Array.isArray(a) ? a.filter(function (x) { return txt(x).trim(); }).join('; ') : ''; }

function montaContexto(p) {
  const ip = p.ip || {};
  const linhasIP = [
    ['Recursos', lista(ip.recursos)], ['Dono', lista(ip.dono)], ['Mão de obra', lista(ip.maoDeObra)],
    ['Origem/Fornecedores', lista(ip.origem)], ['Entradas', lista(ip.entradas)], ['Atividades', lista(ip.atividades)],
    ['Saídas', lista(ip.saidas)], ['Destino', lista(ip.destino)], ['Métodos', lista(ip.metodos)], ['Medição', lista(ip.medicao)]
  ].filter(function (l) { return l[1]; }).map(function (l) { return l[0] + ': ' + l[1]; }).join('\n');
  const mcr = (p.mcr || []).slice(0, 60).map(function (r) {
    const cls = (Number(r.grav) || 0) * (Number(r.prob) || 0);
    return '- [' + txt(r.sub) + '] ' + (r.ro === 'O' ? 'Oportunidade' : 'Risco') + ': ' + txt(r.risco) +
      ' | barreira: ' + txt(r.barreira) + ' | classe: ' + (cls || '-') + (r.norma ? (' | normas: ' + txt(r.norma)) : '');
  }).join('\n');
  return 'PROCESSO: ' + txt(p.codigo) + ' — ' + txt(p.nome) + '\nMissão: ' + txt(p.missao) +
    '\n\nINTERAÇÃO DE PROCESSO:\n' + (linhasIP || '(sem dados de IP)') +
    '\n\nMATRIZ DE RISCOS (por linha):\n' + (mcr || '(sem MCR)');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });

  const KEY = (process.env.GEMINI_API_KEY || '').trim();
  if (!KEY) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });
  try { if (process.env.SESSION_SECRET) { const s = await getSession(req); if (!s) return res.status(401).json({ ok: false, error: 'Não autenticado' }); } } catch (e) {}

  const body = await readBody(req);
  const proc = body.processo || {};
  const requisitos = Array.isArray(body.requisitos) ? body.requisitos : [];
  if (!requisitos.length) return res.status(400).json({ ok: false, error: 'Nenhum requisito informado.' });

  const reqTxt = requisitos.map(function (r) { return '- ' + txt(r.norma) + ' — ' + txt(r.codigo) + ' — ' + txt(r.titulo); }).join('\n');
  const userText = montaContexto(proc) + '\n\nITENS DA NORMA A AUDITAR NESTE PROCESSO:\n' + reqTxt +
    '\n\nGere 2 a 4 perguntas + documentos + comoVerificar para CADA item acima. Responda só o JSON.';

  const MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const reqBody = {
    system_instruction: { parts: [{ text: SYS }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 32768, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
  };
  const URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent?key=' + encodeURIComponent(KEY);
  async function call(b) { const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json().catch(function () { return {}; }); return { r: r, j: j }; }

  try {
    let { r, j } = await call(reqBody);
    if (!r.ok && JSON.stringify(j.error || '').indexOf('thinking') >= 0) { const b2 = JSON.parse(JSON.stringify(reqBody)); delete b2.generationConfig.thinkingConfig; ({ r, j } = await call(b2)); }
    if (!r.ok) return res.status(502).json({ ok: false, error: (j && j.error && j.error.message) ? j.error.message : ('Erro IA (' + r.status + ')') });
    const cand = (j.candidates || [])[0] || {};
    const parts = ((cand.content || {}).parts) || [];
    let text = parts.map(function (p) { return p.text || ''; }).join('').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) { try { parsed = JSON.parse(text.slice(a, b + 1)); } catch (e2) {} } }
    if (!parsed) {
      let msg = 'A IA não retornou um JSON válido.';
      if (cand.finishReason === 'MAX_TOKENS') msg = 'A resposta foi cortada (muitos requisitos). Gere por partes.';
      else if (!text) msg = 'A IA retornou vazio. Verifique o GEMINI_API_KEY e o modelo.';
      return res.status(502).json({ ok: false, error: msg });
    }
    return res.status(200).json({ ok: true, requisitos: Array.isArray(parsed.requisitos) ? parsed.requisitos : [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
