# Relatório de Auditoria de Segurança

| Status da Auditoria | Ferramenta |
| :--- | :--- |
| Seguro (com observações) | Revisão de Git Diff |

**Escopo:** alterações desta sessão — sessão server-side (`lib/session.js`), `middleware.js`, troca de login para Google + bootstrap ADM (`api/auth.js`), controle de acesso por papel/unidade (`api/load.js`, `api/save.js`, `api/backup.js`, `api/terc.js`), rate limiting no Redis e migração para bcrypt.

**Resumo:** o conjunto de mudanças **reduz** significativamente o risco (corrige escalada de privilégio por cookie, segredo estático como token, RBAC só no front-end, CORS curinga, vazamento de stack trace). Não foram introduzidos segredos hardcoded nem novas dependências. Restam **3 observações** de severidade baixa/média descritas abaixo.

---

## 🛑 Não-Conformidades Encontradas

### 1. Verificação de assinatura do `id_token` (Google) ausente
* **Severidade:** `Média`
* **Evidência no Código:**
  ```js
  const part = tj.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
  email = String(payload.email || '').toLowerCase();
  ```
* **Impacto e Risco:** o payload do JWT é decodificado sem validar a assinatura. No fluxo atual o `id_token` vem **direto do endpoint de token do Google** (troca server-to-server autenticada com `client_secret` via TLS), então o risco prático é baixo. Porém, qualquer refator que passe a aceitar o token de outra origem ficaria vulnerável a token forjado.
* **Ação Corretiva Recomendada:**
  ```js
  // Validar via tokeninfo (simples) antes de confiar no e-mail:
  const ti = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tj.id_token));
  const claims = await ti.json();
  if (!ti.ok || claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.email_verified !== 'true') {
    return fail('Token Google inválido.');
  }
  const email = String(claims.email || '').toLowerCase();
  ```

### 2. Concessão de ADM permanente via `BOOTSTRAP_ADMIN_EMAIL`
* **Severidade:** `Baixa`
* **Evidência no Código:**
  ```js
  const boot = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim();
  if (boot && e === boot) {
    return Object.assign({ email: e, nome: 'Administrador', ... }, rec || {}, { email: e, role: 'ADM' });
  }
  ```
* **Impacto e Risco:** o e-mail definido na variável recebe **ADM incondicional**, mesmo sem estar no banco — é um "backdoor" de bootstrap por design. O risco é controlado (exige posse comprovada da conta Google, com `email_verified`), mas é uma concessão permanente enquanto a variável existir.
* **Ação Corretiva Recomendada:**
  ```text
  Operacional (não-código): após o primeiro login, cadastre o ADM definitivo no painel
  e REMOVA a variável BOOTSTRAP_ADMIN_EMAIL do ambiente. Nunca registre o valor em logs.
  ```

### 3. Perda de defesa em profundidade — remoção da trava de domínio
* **Severidade:** `Baixa`
* **Evidência no Código:**
  ```js
  if (!email) return fail('Nao foi possivel obter o e-mail da conta Google.');
  // (removida a verificação email.endsWith('@dominio') — acesso agora só pela allowlist)
  const rec = await getUserRecord(email);
  if (!rec) return fail('Seu e-mail nao tem acesso liberado...');
  ```
* **Impacto e Risco:** mudança **solicitada** (aceitar qualquer e-mail Google). O acesso continua barrado pela allowlist (`getUserRecord`), então não há acesso não autorizado; perde-se apenas uma camada extra. Risco residual: se algum fluxo futuro criar usuários implicitamente, qualquer Gmail entraria. Hoje **nenhum** caminho cria usuário automaticamente.
* **Ação Corretiva Recomendada:**
  ```js
  // Opcional: manter allowlist como gate único (atual) e, se quiser reforçar,
  // restringir o cadastro de novos usuários a um conjunto de domínios confiáveis no painel.
  ```

---

## ✅ Conformidades verificadas (pontos fortes do diff)
- **Sessão server-side** com token aleatório (`crypto.randomBytes(32)`) no Redis com TTL; cookies `HttpOnly; Secure; SameSite=Lax`. Segredo do servidor **não** é mais enviado ao cliente.
- **RBAC no servidor:** papel/unidade derivados da sessão (não de cookie editável); chaves sensíveis (`password_overrides`, `portal_users`, `sgi_users`) restritas a ADM.
- **Proteção CSRF** no OAuth via parâmetro `state`; `SameSite=Lax` nos cookies.
- **Sem segredos hardcoded**; tudo via `process.env`. **Sem novas dependências** (bcryptjs/@upstash já existiam).
- **Validação de input** mantida: `ALLOWED_KEYS`/regex em load/save; `?file=` do backup sanitizado contra path traversal.
- **Hashing** migrado para **bcrypt** com migração transparente; **rate limiting** movido para Redis (eficaz em serverless).
- **Erros genéricos** (sem stack trace) nas respostas.

> Parecer: **apto para deploy** após (a) configurar `GOOGLE_CLIENT_ID/SECRET` e `BOOTSTRAP_ADMIN_EMAIL`, e (b) teste no preview. As 3 observações acima são melhorias recomendadas, não bloqueadoras.
