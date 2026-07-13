# Levar o módulo de Condicionantes da LO para outro site
### Manual de portabilidade · Central SGI/METIS · 13/07/2026

O módulo é autocontido: 4 arquivos próprios + 2 dependências. Este manual lista o que copiar,
o que configurar e o que adaptar. Tempo estimado: 1–2 horas num site Vercel parecido com este.

## 1. Arquivos a copiar (deste repositório)

| Arquivo | O que é | Obrigatório |
|---|---|---|
| `condicionantes.html` | O painel completo (tela) | Sim |
| `cumprir.html` | Página pública de registro de cumprimento (via token) | Sim |
| `lib/condlo.js` | Motor de avisos diários (frequências, escalonamento, marco 120d) | Sim |
| `lib/condlo_api.js` | Handler HTTP (CRUD, cumprimento, upload, extração por IA) | Sim |
| `lib/session.js` | Sessão via cookie + Redis (dependência) | Sim, ou adapte (ver §5) |
| `lib/gmail.js` | Envio de e-mail via Gmail SMTP (dependência) | Sim, ou adapte (ver §5) |

## 2. Expor a rota da API

No site de destino, se houver folga no limite de funções da Vercel (Hobby = 12), crie
`api/condlo.js` com uma linha:

```js
module.exports = require('../lib/condlo_api');
```

Se o site também estiver no limite de 12 funções, faça como fizemos aqui: desvio dentro de uma
função existente + rewrite no `vercel.json`:

```js
// no início do handler de uma função existente:
if (req.query && req.query.condlo_api) return require('../lib/condlo_api')(req, res);
```
```json
{ "rewrites": [ { "source": "/api/condlo", "destination": "/api/SUAFUNCAO?condlo_api=1" } ] }
```

## 3. Cron diário (avisos às 7h30 de Brasília)

No handler do cron do site de destino (ou um novo `api/cron.js`), chame:

```js
const { checkCondLo } = require('../lib/condlo');
const { sendMail, gmailConfigured } = require('../lib/gmail');
// dentro do handler, com o cliente Redis já criado:
await checkCondLo(redis, { sendMail, gmailConfigured }, process.env.SITE_URL);
```

E no `vercel.json`: `{ "crons": [ { "path": "/api/cron", "schedule": "30 10 * * *" } ] }`
(10h30 UTC = 7h30 Brasília). Proteja o cron com segredo (padrão daqui: header
`Authorization: Bearer CRON_SECRET`).

## 4. Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Para quê |
|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (banco de tudo; chave usada: `condicionantes_lo`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Storage dos anexos (bucket `terceiros-docs`, pasta `condlo/` — bucket configurável na constante `BUCKET` do `lib/condlo_api.js`) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Envio dos avisos (senha de app do Gmail) |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`, opcional) | Extração das condicionantes do PDF por IA |
| `SITE_URL` | Base https usada nos links dos e-mails |
| `SESSION_SECRET` | Exigida pelo padrão de sessão deste sistema |

## 5. Autenticação e papéis — o único acoplamento real

O módulo espera:

- `lib/session.js` com `getSession(req)` retornando `{ role, email, unidades }` a partir do
  cookie `raitz_session` + Redis. Se o site de destino tem OUTRO login, reescreva só o
  `getSession` mantendo o contrato de retorno.
- Papéis: `ADM` e `SGI` (tudo), `Gestor` (edita/registra), demais (leitura).
- Chave Redis `sgi_users` (`{ email: { role, unidades } }`) — usada pelo motor para achar os
  ADMs (cópia nos avisos) e os gestores por unidade (escalonamento no 3º dia de atraso).
  Se o site de destino não tiver, crie a chave com esse formato ou adapte `usersByRole()`
  em `lib/condlo.js`.
- Middleware: liberar como PÚBLICAS as rotas `/cumprir.html` e `/api/condlo`
  (a segurança delas é por token individual, validado no servidor).

## 6. Adaptações de identidade (buscar e trocar)

- **Unidades:** `RESENDE / JOINVILLE / CURITIBA` estão fixas no `<select id="l-unidade">` do
  `condicionantes.html` — troque pelas unidades do site de destino.
- **E-mail de fallback do ADM:** em `lib/condlo.js` (função `usersByRole`) há um e-mail padrão
  caso a chave `sgi_users` esteja vazia — troque.
- **Marca:** o topo do `condicionantes.html` mostra "◈ METIS" quando aberto fora de iframe —
  troque pelo nome do sistema de destino. Embutido em iframe, o cabeçalho some sozinho
  (padrão `body.embedded`, ver `PADRAO-MODULOS.md`).
- **Domínio de fallback** na constante `BASE_URL` do `lib/condlo_api.js`.

## 7. Integração no menu (opcional)

O `condicionantes.html` funciona sozinho (URL direta) ou embutido. Para embutir no menu de um
sistema como este: item de menu chamando `navigate('condicionantes', this)`, um
`<div class="page"><iframe id="condicionantes-frame"></iframe></div>` e o caso no `navigate()`
que faz `frame.src='condicionantes.html'` na primeira abertura (exemplo real no `index.html` daqui).

## 8. Checklist de teste pós-instalação

1. Login como ADM → abrir o painel → cadastrar uma licença de teste com validade próxima.
2. Criar 1 condicionante mensal com prazo para amanhã e seu e-mail como responsável.
3. Botão "▶ Verificar agora" → conferir se o e-mail chegou com o botão verde.
4. Clicar no botão do e-mail → registrar cumprimento com anexo → conferir que o próximo
   prazo foi agendado (+1 mês) e que o histórico guarda protocolo e arquivo.
5. "📥 Importar em lote" → "🤖 Extrair do PDF" com uma LO real → conferir extração.
6. "📦 Dossiê" → imprimir/PDF.
7. Entrar com usuário sem papel de edição → confirmar que só visualiza.
