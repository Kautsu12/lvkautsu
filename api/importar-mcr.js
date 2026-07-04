// api/importar-mcr.js — lê planilhas (Excel) com IA (Gemini) e extrai IP e/ou MCR em JSON estruturado.
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

const SYS = `Você é um extrator de dados de planilhas de SGI (Sistema de Gestão Integrado) de uma empresa de galvanização.
Recebe o conteúdo (em CSV) de uma ou mais abas de um arquivo Excel e devolve APENAS um JSON válido, sem texto fora do JSON, no formato:
{
  "processo": "nome do processo, se identificável (ex.: Realização do produto, Alta Direção)",
  "has": { "ip": true|false, "mcr": true|false },
  "ip": {
    "missao": "texto da missão do processo, se houver",
    "recursos": [], "dono": [], "maoDeObra": [], "origem": [], "entradas": [],
    "atividades": [], "saidas": [], "destino": [], "metodos": [], "medicao": []
  },
  "mcr": [
    {
      "sub": "item / requisito / sub-atividade (agrupador)",
      "categoria": "SGQ|SGA|SSO|Outro ou vazio",
      "norma": "normas relacionadas, se houver (ex.: ISO 9001)",
      "requisito": "cláusula da norma, se houver (ex.: 8.5)",
      "ro": "R para risco, O para oportunidade",
      "risco": "descrição do risco ou oportunidade",
      "conseq": "consequências",
      "barreira": "barreira de proteção / controle",
      "grav": 1, "prob": 1,
      "gravP": "", "probP": "",
      "perda": "", "freq": "",
      "acao": "", "prazo": "", "resp": "", "dataReal": "",
      "eficaz": "", "dataEfic": "", "respEfic": ""
    }
  ]
}
REGRAS:
- Interação de Processo (IP) é o diagrama de tartaruga: recursos, dono do processo, mão de obra, origem/informações, entradas, atividades do processo, saídas, destino/informações, métodos, medição/monitoramento e missão. Se a planilha tiver isso, preencha "ip" e marque has.ip=true. Se não, deixe "ip" com listas vazias e has.ip=false.
- MCR é a Matriz de Classificação de Riscos e Oportunidades (colunas de Risco/Oportunidade, Consequências, Barreira, Gravidade, Probabilidade). Se existir, preencha "mcr" e has.mcr=true. Se não, "mcr":[] e has.mcr=false.
- Faça preenchimento para baixo (fill-down) de células mescladas (Item, Categoria, Normas, Requisitos que valem para várias linhas).
- "grav" e "prob" são inteiros de 1 a 3 (atual). "gravP"/"probP" são a classificação APÓS a ação, de 1 a 3, ou "" se não houver.
- "freq" (frequência anual): converta Baixa=1, Média=3, Alta=5; se vier número, use o número; senão "".
- "perda" (perda média em R$): apenas o número, sem separadores nem "R$" (ex.: 200000). Se não houver, "".
- "categoria": normalize para SGQ, SGA, SSO ou Outro quando possível.
- Ignore linhas totalmente vazias e linhas de cabeçalho. Não invente dados: use "" ou [] quando a informação não existir.
- Responda SOMENTE com o JSON.`;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });

  const KEY = (process.env.GEMINI_API_KEY || '').trim();
  if (!KEY) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });

  // Autenticação (mesmo padrão do save/load). Se a sessão não estiver configurada, segue sem bloquear.
  try {
    if (process.env.SESSION_SECRET) {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ ok: false, error: 'Não autenticado' });
    }
  } catch (e) { /* não bloqueia a importação por falha de checagem */ }

  const body = await readBody(req);
  const sheets = Array.isArray(body.sheets) ? body.sheets : [];
  if (!sheets.length) return res.status(400).json({ ok: false, error: 'Nenhuma planilha recebida.' });

  const joined = sheets.slice(0, 8).map(function (s, i) {
    return '## Aba ' + (i + 1) + ': ' + String(s.name || ('Planilha ' + (i + 1))) + '\n' + String(s.csv || '').slice(0, 16000);
  }).join('\n\n');
  const userText = 'Extraia IP e/ou MCR do conteúdo abaixo e responda só o JSON.\n\n' + joined;

  const MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const reqBody = {
    system_instruction: { parts: [{ text: SYS }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      // gemini-2.5-* liga "thinking" por padrão, o que consome o orçamento de saída
      // e trunca o JSON. Desligamos para a resposta sair completa.
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent?key=' + encodeURIComponent(KEY);
  async function call(body) {
    const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(function () { return {}; });
    return { r: r, j: j };
  }
  try {
    let { r, j } = await call(reqBody);
    // Alguns modelos não aceitam thinkingConfig → tenta de novo sem ele.
    if (!r.ok && JSON.stringify(j.error || '').indexOf('thinking') >= 0) {
      const b2 = JSON.parse(JSON.stringify(reqBody)); delete b2.generationConfig.thinkingConfig;
      ({ r, j } = await call(b2));
    }
    if (!r.ok) return res.status(502).json({ ok: false, error: (j && j.error && j.error.message) ? j.error.message : ('Erro IA (' + r.status + ')') });

    const cand = (j.candidates || [])[0] || {};
    const finish = cand.finishReason || '';
    const parts = ((cand.content || {}).parts) || [];
    let text = parts.map(function (p) { return p.text || ''; }).join('').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const a = text.indexOf('{'), b = text.lastIndexOf('}');
      if (a >= 0 && b > a) { try { parsed = JSON.parse(text.slice(a, b + 1)); } catch (e2) {} }
    }
    if (!parsed) {
      let msg = 'A IA não retornou um JSON válido.';
      if (finish === 'MAX_TOKENS') msg = 'A planilha é grande e a resposta da IA foi cortada. Tente importar uma aba por vez.';
      else if (finish === 'SAFETY' || finish === 'RECITATION') msg = 'A IA bloqueou a resposta (' + finish + ').';
      else if (!text) msg = 'A IA retornou vazio' + (finish ? (' (' + finish + ')') : '') + '. Verifique o GEMINI_API_KEY e o modelo (GEMINI_MODEL).';
      return res.status(502).json({ ok: false, error: msg });
    }
    return res.status(200).json({ ok: true, processo: parsed.processo || '', has: parsed.has || {}, ip: parsed.ip || null, mcr: Array.isArray(parsed.mcr) ? parsed.mcr : [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
