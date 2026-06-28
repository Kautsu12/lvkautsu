# Auditoria de Cibersegurança — Central SGI Raitz (revisão de código)

**Alvo:** https://centralsgiraitz.vercel.app · repositório `ArquivosLVSGI-main`
**Stack:** Vercel (Functions + Edge Middleware), Upstash Redis (KV), Supabase Storage, OAuth Microsoft (Entra ID), Nodemailer/Resend
**Data:** 27/06/2026 · **Autorização:** proprietário · **Escopo:** revisão estática de código (não-intrusiva)

---

## 1. Resumo executivo

A arquitetura tem boas decisões de base — middleware de sessão **aplicado no servidor**, OAuth Microsoft com proteção `state`, restrição de domínio validada no backend, e um **Portal do Fornecedor muito bem implementado** (bcrypt + sessão server-side no Redis com TTL).

Porém, o **módulo interno (admin J/R)** concentra falhas graves de **controle de acesso** e **gestão de sessão**. As três mais sérias permitem, na prática, que **qualquer colaborador autorizado a logar** leia e altere **todos os dados do sistema, incluindo os hashes de senha**, e se eleve a **administrador (ADM)** editando um cookie. Recomendo tratar os itens CRÍTICOS antes de seguir usando o sistema com dados reais.

A boa notícia: o padrão correto **já existe no próprio projeto** (a sessão do portal). A maior parte das correções é replicar esse modelo no módulo interno.

---

## 2. Achados CRÍTICOS

### 🔴 C1 — Escalada de privilégio: o papel ADM vem de um cookie editável (`raitz_email`)
O papel do usuário é lido do cookie `raitz_email`, que **não é HttpOnly nem está vinculado à sessão de forma assinada**.

- `api/auth.js` → `getCurrentEmail()` lê `raitz_email` do cookie; `currentRecord()` busca o papel por esse e-mail; o gate de ADM (`me.role !== 'ADM'`) confia nisso.
- `api/backup.js` → `roleOf()` faz o mesmo para liberar **download/restauração de todo o banco**.

**Impacto:** qualquer usuário logado pode trocar o cookie para `ayrton.ribeiro@galvanizacaoraitz.com.br` (ADM conhecido — está até nos créditos do site) e assumir privilégios de administrador: gerenciar usuários, **baixar o banco inteiro** (`/api/backup?download=1`) e **sobrescrever qualquer chave** (`/api/backup?restore=1`).

**Correção:** nunca derivar autorização de um cookie editável. O papel deve vir de uma **sessão assinada/armazenada no servidor** (ver C3) e ser reconsultado no backend a cada requisição.

### 🔴 C2 — Autorização por papel/unidade não é aplicada no servidor (RBAC só no front-end)
`api/load.js` e `api/save.js` autorizam apenas por "está logado?" (`getUser` = sessão J/R). **Não checam papel nem unidade.** A lista `ALLOWED_KEYS` inclui chaves sensíveis como **`password_overrides`** (hashes de senha internos) e **`portal_users`** (hashes bcrypt e dados dos fornecedores).

**Impacto:** todo usuário que loga via Microsoft vira sessão `R` (em `msCallback`, o cookie é sempre `...:R`). Portanto **qualquer colaborador no allowlist** — independente de ser "Usuário", "Gestor" ou "SGI" — pode:
- `GET /api/load?key=password_overrides` → ler hashes de senha;
- `GET /api/load?key=terceiros` → ver dados de **todas** as unidades (ignorando a segregação por unidade);
- `POST /api/save` em qualquer chave → adulterar dados, sobrescrever `portal_users`, etc.

A separação ADM/SGI/Gestor/Usuário e por unidade existe **somente na interface** — no servidor ela não é imposta.

**Correção:**
1. Aplicar verificação de **papel e unidade no servidor** em `load`/`save`/`backup`.
2. Restringir chaves sensíveis (`password_overrides`, `portal_users`, `sgi_users`) a **ADM** e **nunca** expô-las pelo endpoint genérico de `load`.
3. Filtrar dados por unidade no backend para papéis Gestor/Usuário.

### 🔴 C3 — `SESSION_SECRET` estático é o próprio token de sessão de todos (e é reusado como chave de senha)
O cookie de sessão interno é literalmente `raitz_session = <SESSION_SECRET>:<J|R>` — ou seja, **o segredo do servidor é enviado ao navegador** e é **o mesmo para todos**. O mesmo `SESSION_SECRET` também é a **chave HMAC** que protege as senhas internas (`crypto.createHmac('sha256', sessionSecret)`).

**Impacto:** não há sessão por usuário, nem assinatura, nem rotação. Se esse valor vazar em **um único lugar** (um dispositivo, um log, uma extensão de navegador, um computador compartilhado), o atacante pode **forjar `raitz_session` para sempre** e, por ser também a chave HMAC, **forjar/quebrar hashes de senha**. É uma chave-mestra única.

**Correção (reusar o padrão do portal):** gerar token de sessão **aleatório por login**, guardar no Redis (`session:{token}` → `{email, role, exp}`) com TTL, cookie HttpOnly/Secure/SameSite — exatamente como `portal-auth.js` já faz. Usar **chaves separadas** para assinatura de sessão e para hashing de senha, e permitir rotação.

---

## 3. Achados ALTO / MÉDIO

### 🟠 A1 — Hashing de senha interno fraco
Senhas internas usam **HMAC-SHA256** (hash rápido) com mínimo de **6 caracteres**. Como os hashes são acessíveis (ver C2) e a chave é o `SESSION_SECRET` (ver C3), o custo de quebra é baixo. **Correção:** usar **bcrypt/argon2** (o projeto já depende de `bcryptjs`) e exigir senhas mais fortes (≥ 10–12).

### 🟠 A2 — Rate limiting em memória é ineficaz em serverless
`api/auth.js` e `api/portal-auth.js` guardam tentativas em `Map` na memória do processo. Funções Vercel são efêmeras e escalam em várias instâncias → o limite **reseta** e não barra força-bruta distribuída. **Correção:** mover o controle para o **Redis** (chave por IP+e-mail com TTL).

### 🟠 A3 — Chaves sensíveis acessíveis via `load`/`save`
(Decorre de C2, mas vale destacar.) `password_overrides` e `portal_users` jamais deveriam trafegar pelo endpoint genérico. **Correção:** removê-las de `ALLOWED_KEYS` e tratar por endpoints dedicados com checagem de ADM.

### 🟡 M1 — CORS `Access-Control-Allow-Origin: *`
`api/auth.js`, `api/load.js` e `api/save.js` respondem com origem curinga. O `SameSite=Lax` mitiga o pior, mas o curinga é desnecessário e amplia a superfície. **Correção:** restringir à própria origem (ou remover o cabeçalho).

### 🟡 M2 — Vazamento de stack trace em erros
`load.js`/`save.js` retornam `err.message` e parte do `stack` ao cliente. **Correção:** logar internamente e devolver mensagem genérica (ex.: "Erro interno").

### 🟡 M3 — Ausência de cabeçalhos de segurança HTTP
`vercel.json` só tem crons — sem HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. **Correção:** ver bloco no item 5.

### 🟡 M4 — `backup?file=` sem sanitização (path traversal)
No modo cron, `req.query.file` é concatenado direto na URL do Supabase. Exige `CRON_SECRET` (risco reduzido), mas deve ser validado contra uma allowlist/prefixo. 

---

## 4. Baixo / Informativo

- **B1 — Matching de rotas públicas por `startsWith`** no middleware é frágil; usar comparação exata (`===`) ou `startsWith(p + '/')`.
- **B2 — Logout não limpa** `raitz_email` nem `raitz_login_at` (apenas `raitz_session`).
- **B3 — `id_token` não tem assinatura verificada** — aceitável aqui (vem direto do endpoint de token via TLS), mas validar é boa prática.
- **B4 — `change_password` exige só 6 caracteres.**

---

## 5. Pontos positivos (manter)

- **Portal do Fornecedor** (`portal-auth.js`): bcrypt, sessão **server-side** no Redis com TTL de 24h, token aleatório de 32 bytes, cookies HttpOnly/Secure/SameSite. **É o modelo a replicar no módulo interno.**
- **OAuth Microsoft** com parâmetro `state` (anti-CSRF), validação de domínio `@galvanizacaoraitz.com.br` e allowlist de usuários **no servidor**.
- **Middleware real no servidor** (não é só redirecionamento no navegador).
- **Sem open redirect** (o `redirect` vem do `pathname`; o callback vai para `/`).
- `SameSite=Lax` + `timingSafeEqual` no comparativo de senha.
- **Sem segredos hardcoded** no código; `.env` fora do repositório.

---

## 6. Correções prioritárias (ordem sugerida)

**Imediato (CRÍTICO):**
1. **C1/C3** — Substituir o cookie `SECRET:user` por sessão server-side no Redis (replicar `portal-auth.js`), guardando `email` e `role`. Parar de confiar no cookie `raitz_email` para autorização.
2. **C2/A3** — Impor papel/unidade no servidor em `load`/`save`/`backup`; remover `password_overrides` e `portal_users` de `ALLOWED_KEYS`.

**Em seguida (ALTO/MÉDIO):**
3. **A1** — Migrar senhas internas para bcrypt; exigir senha mais forte.
4. **A2** — Rate limiting no Redis.
5. **M1/M2** — Tirar CORS `*`; retornar erros genéricos.
6. **M3** — Adicionar cabeçalhos de segurança no `vercel.json`.
7. **M4/B1** — Sanitizar `backup?file=`; endurecer o match de rotas públicas.

### Exemplo — cabeçalhos de segurança (`vercel.json`)
```json
{
  "version": 2,
  "crons": [
    { "path": "/api/backup",      "schedule": "0 11 * * *" },
    { "path": "/api/portal-cron", "schedule": "0 8 * * *" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "X-Content-Type-Options",     "value": "nosniff" },
        { "key": "X-Frame-Options",            "value": "DENY" },
        { "key": "Referrer-Policy",            "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy",         "value": "camera=(), microphone=(), geolocation=()" }
      ]
    }
  ]
}
```
> CSP foi omitida de propósito: as páginas usam `onclick`/scripts inline e `data:` em imagens. Uma CSP estrita exigirá refatorar esses pontos (ou usar nonces). Vale fazer depois dos itens críticos.

### Exemplo — autorização por papel no servidor (esboço)
```js
// helper único, usado em load/save/backup/auth
async function getSession(req, redis) {
  const token = parseCookies(req)['raitz_session']; // token aleatório, NÃO o segredo
  if (!token) return null;
  return await redis.get(`session:${token}`); // { email, role, unidades, exp }
}
function requireRole(session, roles) {
  return session && roles.includes(session.role);
}
// em load.js, antes de ler chave sensível:
const s = await getSession(req, redis);
if (!s) return res.status(401).json({ error: 'Não autenticado' });
const SENSIVEIS = ['password_overrides', 'portal_users', 'sgi_users'];
if (SENSIVEIS.includes(key) && s.role !== 'ADM')
  return res.status(403).json({ error: 'Acesso negado' });
```

---

## 7. Correções aplicadas neste commit

Implementadas as falhas **críticas** de controle de acesso e sessão, mais várias de menor severidade.

**Arquivos alterados** (originais salvos em `_backup_seguranca/`):
- **`lib/session.js`** (novo) — sessão interna **server-side** no Redis: token aleatório de 32 bytes por login, TTL de 8h, guardando `email`, `role` e `unidades`. Mesmo padrão do portal do fornecedor.
- **`middleware.js`** — passa a validar a sessão consultando o Redis (rejeita o formato antigo `segredo:user`); match de rotas públicas por igualdade exata (corrige B1).
- **`api/auth.js`** — login Microsoft e por senha agora **criam a sessão server-side**; identidade e papel vêm da sessão (não mais do cookie `raitz_email`); logout **revoga** a sessão no Redis e limpa cookies; removido CORS `*`.
- **`api/load.js` / `api/save.js`** — usam a sessão; **chaves sensíveis** (`password_overrides`, `portal_users`, `sgi_users`) só para **ADM**; erros genéricos (sem stack trace); sem CORS `*`.
- **`api/backup.js`** — papel vem da sessão (não do cookie); `?file=` sanitizado contra path traversal.
- **`api/auth.js`** (2ª rodada) — senhas internas passam a usar **bcrypt** (com suporte ao hash legado e **migração transparente no login**); **rate limiting no Redis**; mínimo de senha 6 → **8**.
- **`api/portal-auth.js`** — **rate limiting no Redis** (antes em memória).
- **`api/terc.js`** (3ª rodada) — sessão server-side; o **escopo por unidade/papel** (que já existia, mas lia o cookie editável `raitz_email`) agora usa a **identidade confiável da sessão** em `scopeUnits`, `docintScope` e `roleOf`; erro genérico (sem `err.message`). **Completa o C2** para o módulo ativo de Terceiros.
- **`api/portal-invite.js`** — sessão server-side (estava no formato antigo, quebraria após o deploy).
- **`vercel.json`** — adicionados HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.

**Resolve:** C1 (escalada por cookie), **C2** (escopo por unidade/papel agora server-side e baseado em identidade confiável; chaves sensíveis e backup exigem ADM), C3 (segredo estático como token), **A1** (bcrypt), **A2** (rate limiting no Redis), M1 (CORS), M2 (stack trace), M3 (headers), M4 (path traversal), B1, B2, B4 (senha mín. 8).

> **Importante (correção de regressão):** o módulo de Terceiros (`terc.js`) e o convite de fornecedor (`portal-invite.js`) ainda usavam o formato de sessão antigo (`SESSION_SECRET:user`). A troca para sessão server-side **os teria quebrado** — por isso foram migrados nesta rodada. Confirmado que **nenhum** endpoint em `api/` ainda valida sessão pelo formato antigo.

**Pendências (recomendado fazer a seguir):**
- **CSP** — adicionar Content-Security-Policy após refatorar `onclick`/scripts inline.
- **Hardening opcional** — tornar `raitz_email` HttpOnly (hoje só é usado para atribuição em logs; o controle de acesso já não depende dele).

**Notas de implantação:**
- Não exige variável de ambiente nova: a sessão e o rate limiting usam as `KV_REST_API_*` já existentes; `SESSION_SECRET` continua válido para o hash legado durante a migração.
- **Migração de senha sem fricção:** hashes antigos (HMAC) continuam funcionando no login e são **regravados como bcrypt automaticamente** no primeiro login bem-sucedido (quando o Redis está disponível). `bcryptjs` já é dependência.
- **Todos os usuários logados serão deslogados** após o deploy (cookies no formato antigo deixam de valer) — basta logar de novo.
- O middleware passa a fazer uma consulta ao Redis por requisição (Edge) — testar latência e o fluxo: login Microsoft → `whoami` → salvar/carregar dados → backup como ADM e como não-ADM → trocar senha → 6 logins errados (deve bloquear ~15 min).

> Observação técnica: a validação automática de sintaxe (`node --check`) foi feita; `lib/session.js`, `load.js`, `save.js` e `middleware.js` passaram. Em `auth.js` e `backup.js` o ambiente de teste espelhava os arquivos de forma corrompida, então a integridade foi confirmada por inspeção direta do arquivo no disco. Recomenda-se rodar `vercel dev`/build localmente antes do deploy.

---

## 8. Limpeza da "quimera" (arquivos sobrepostos/legados)

Mapeei como as páginas se conectam para separar o que é usado do que é resto de versões antigas.

**Estrutura ativa (mantida):**
`login.html` → `index.html` (carrega via iframe: `terceiros.html`, `organograma.html`, `auditoria.html`, `lista_mte.html`→`mte.html`, `lista_auditorias.html`, `programa_auditoria.html`); `portal.html`→`portal_docs.html` (fornecedor); `rnc.html` e `renew.html` (fluxos públicos por token). APIs ativas: `auth`, `load`, `save`, `terc`, `backup`, `portal-*`, `renew_document`. `lib/`: todas as libs são referenciadas.

**Removidos do site ativo (não referenciados por nada — eram cópias antigas):**
- `index_backup_pretabs.html`
- `terceiros_backup_pretabs.html`
- `terceiros_legacy_backup.html`
- `portal_docs_backup.html`

Para segurança, **não foram apagados de vez**: foram movidos para `_arquivo_descontinuado/` (recuperável) e essa pasta entrou no `.gitignore` para não ir ao deploy. ~433 KB de código morto fora do ar.

**Sobreposição de dados corrigida:**
- A chave Redis legada **`terceiros`** foi removida de `ALLOWED_KEYS` em `load.js`/`save.js`. O módulo ativo usa **`terceiros_sgi`** via `/api/terc` — a chave antiga não era usada por nenhuma página (caminho de acesso morto, agora fechado). Os dados antigos no Redis não são apagados; apenas deixam de ser acessíveis pela API genérica.

**Como aplicar a limpeza no repositório real (GitHub):**
Como sua pasta local é um ZIP do GitHub (sem `.git`), a remoção precisa ser feita no repositório: **apague** estes 4 arquivos do repo (`index_backup_pretabs.html`, `terceiros_backup_pretabs.html`, `terceiros_legacy_backup.html`, `portal_docs_backup.html`) e suba as versões novas de `load.js` e `save.js`.

**Recomendações adicionais (opcionais):**
- Manter cópias de backup **fora** do diretório publicado (ex.: um branch `arquivo` ou pasta local), nunca no root do deploy.
- Padronizar um único módulo de Terceiros (já é `terc.js`/`terceiros_sgi`); evitar reintroduzir páginas `*_backup_*`.

---

## 9. Consolidação do front-end (sobreposição de código)

Analisei a duplicação de código entre as páginas. Nem tudo que "parece" duplicado é duplicado de verdade — separei os casos.

**Duplicação real removida:**
- **Logo (imagem embutida em base64):** 4 páginas (`login`, `index`, `portal`, `portal_docs`) tinham **a mesma** imagem de ~12,7 KB embutida cada uma. Extraída para **`assets/logo.jpg`** (9,5 KB, arquivo único) e referenciada por `<img src="/assets/logo.jpg">`. (A `auditoria.html` usa uma imagem **diferente/única** — não é duplicata, foi mantida.)
- **Script de tema claro/escuro:** `login`, `portal` e `portal_docs` tinham o **mesmo** bloco JS (idêntico). Extraído para **`assets/tema.js`** e referenciado por `<script src="/assets/tema.js">`.
- **Middleware:** `/assets` adicionado às rotas públicas (senão o logo/tema seriam bloqueados na tela de login, que é pública).

**Deixado de propósito (não é duplicação verdadeira / risco alto):**
- **CSS de tema escuro (`body.dark ...`)** é **específico de cada página** (cada uma estiliza suas próprias classes). Não é código repetido — unificar mudaria a aparência e exigiria teste visual página a página. Mantido em cada arquivo.
- **`index.html` e `terceiros.html`** têm o tema e os helpers **entrelaçados** no script principal do app (blocos de ~90–130 KB). Extrair sem teste visual é arriscado — mantidos como estão (o logo destes, sim, foi externalizado).

**Arquivos novos a subir no repositório:** `assets/logo.jpg`, `assets/tema.js`.
**Arquivos alterados:** `middleware.js`, `login.html`, `index.html`, `portal.html`, `portal_docs.html`.
**Backups dos originais:** em `_backup_seguranca/frontend/` (recuperável).

> **Teste visual obrigatório no preview:** abrir `login.html`, `portal.html`, `portal_docs.html` e o `index.html` e confirmar que **o logo aparece** e que o **botão de tema (lua/sol)** funciona. Como o logo agora é um arquivo servido em `/assets/`, ele só carrega corretamente após o deploy com a pasta `assets/` incluída e o middleware atualizado.

---

## 10. Mudanças funcionais solicitadas (módulos + login)

### 10.1 Remoção de módulos
Removidos do `index.html`: **Gestão de Terceiros**, **Organograma**, **Recursos Humanos (Gestão de Treinamento)** e **SESMT (Gestão de EPI)**.
- Removidos: itens do menu lateral, painéis de conteúdo e referências em JS (mapa de páginas, mapa de permissões `ACCESS`, roteamento pós-login e a lista de módulos do admin).
- Arquivos arquivados em `_arquivo_descontinuado/`: `terceiros.html`, `organograma.html`.
- **Mantidos e intactos:** Auditoria, Auditorias MTE, Relatórios, Documentos · Vencimentos, Manual, Configurações.
- Funções auxiliares órfãs (ex.: `showTerceirosPage`) ficaram no código mas **nunca são chamadas** (sem efeito). Podem ser limpas depois.

### 10.2 Login: Microsoft (Azure AD) → Google (OAuth)
Alterado em `api/auth.js` e `login.html`:
- O fluxo agora usa **Google OAuth 2.0** (`accounts.google.com/o/oauth2/v2/auth` + `oauth2.googleapis.com/token`), lendo o e-mail do `id_token`/`userinfo`. Mantidos: proteção `state` (anti-CSRF), **restrição ao domínio `@galvanizacaoraitz.com.br`** e a allowlist de usuários — tudo validado **no servidor**.
- Botão da tela de login agora é "**Entrar com conta Google**" (ícone do Google).

**Variáveis de ambiente (Vercel):**
- **Adicionar:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (marcar para Production **e** Preview).
- **Pode remover:** `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` (não são mais usados).

**Configuração no Google Cloud Console (obrigatória):**
1. APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → tipo **Web application**.
2. **Authorized redirect URIs:** adicionar `https://centralsgiraitz.vercel.app/api/auth` (e a URL `/api/auth` de cada Preview que for testar).
3. **OAuth consent screen:** se o domínio `galvanizacaoraitz.com.br` for **Google Workspace**, configure como **Internal** (restringe à organização automaticamente).
4. Copie Client ID/Secret para as variáveis acima.

> ⚠️ **Pré-requisito a confirmar:** o login Google só funciona se os colaboradores tiverem **conta Google nesse domínio** (Google Workspace). Se o e-mail `@galvanizacaoraitz.com.br` for **Microsoft 365** (e não Google Workspace), o login Google não autenticará esses usuários — nesse caso seria necessário Google Workspace ou contas Google associadas.

### 10.3 Teste obrigatório no preview
- Tela de login mostra "Entrar com conta Google" e o logo aparece.
- Login com um e-mail `@galvanizacaoraitz.com.br` autorizado → entra e cai num módulo válido (Documentos/Configurações/Auditoria).
- O menu **não** mostra mais Terceiros, Organograma, RH nem SESMT; Auditoria/MTE/Documentos/Configurações funcionam.

---

## 11. Desmarcação ("o site é meu") — remoção da marca Raitz

- **Logo (imagem):** removido das telas (`login`, `index`, `portal`, `portal_docs`) e **dos PDFs** da Auditoria (a imagem `RAITZ_LOGO_B64` foi trocada por um JPEG branco 1×1 — os relatórios continuam gerando, sem o logo). Asset `assets/logo.jpg` arquivado.
- **Textos de marca:** "Raitz Galvanização" / "Central SGI Raitz" / "SGI Raitz" → **"Central SGI"** em títulos, cabeçalhos, rodapés, tela de login e **templates de e-mail** (backup, convite de fornecedor, cobranças, alertas) e no nome remetente (`lib/gmail.js`, via `MAIL_FROM_NAME`).
- **Login:** removida a trava de domínio `@galvanizacaoraitz.com.br` — agora **qualquer e-mail Google** é aceito, mas o acesso continua **controlado pela allowlist de usuários** (só entra quem um ADM liberou).

**Deixado como está (conteúdo/dados, não marca):** dados de exemplo no dashboard (`Raitz Ind. Ltda` etc.), entradas de histórico/changelog, campos editáveis de exemplo no `programa_auditoria.html`, e o nome interno da variável `RAITZ_LOGO_B64`. São conteúdos que você edita/limpa no uso normal.

> ✅ **Acesso de login (resolvido via bootstrap):** como a trava de domínio saiu, o controle passa a ser 100% pela allowlist. Foi adicionado um **bootstrap de ADM por variável de ambiente**: defina na Vercel **`BOOTSTRAP_ADMIN_EMAIL=ayrton1711@gmail.com`** (Production + Preview). Esse e-mail entra como **ADM** mesmo sem estar na lista do banco, garantindo o primeiro acesso. Depois de entrar, você pode cadastrar/editar os demais usuários pelo painel de Configurações. (Implementado em `getUserRecord`, `api/auth.js`.)

---

*Auditoria estática, não-intrusiva. Não houve exploração ativa nem testes contra o ambiente em produção. Para um sistema com dados de colaboradores e fornecedores, recomenda-se, após as correções, um pentest autorizado completo.*
