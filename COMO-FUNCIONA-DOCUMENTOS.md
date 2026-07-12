# Central SGI — Gestão de documentos internos (Vencimentos)
### Explicação em linguagem simples · atualizado em 11/07/2026

## O que é o projeto

O Central SGI é o sistema interno da empresa que reúne, num só lugar, as rotinas do sistema de gestão: auditoria interna, auditorias MTE, registros de não conformidade (RNC), relatórios, escopo, mapa de processos (IP & MCR), manuais, portal de documentos de terceiros e a **gestão de documentos internos com controle de vencimento** — que é o módulo explicado neste documento.

A ideia do módulo de documentos é simples: **nenhum documento com prazo (alvará, licença, ASO, treinamento, certificado) pode vencer sem que alguém seja avisado antes**. O sistema guarda a lista de documentos, conta os dias para o vencimento de cada um e manda e-mail automático para o responsável quando o prazo se aproxima.

## O que o módulo faz, na prática

Cada documento cadastrado tem: nome, tipo (ex.: Alvará Sanitário, NR-06 EPI), unidade (Resende, Joinville ou Curitiba), responsável com e-mail, cargo, data de vencimento, status (ativo, renovado ou inativo) e o arquivo em si — anexado no sistema ou como link (ex.: pasta do Drive).

A tela mostra quatro contadores no topo (vencidos, vencem em 7 dias, vencem em 30 dias, total de ativos) e uma tabela com todos os documentos, ordenada do prazo mais apertado para o mais folgado. Dá para filtrar por unidade, cargo, tipo, status e buscar por texto.

Quem vê o quê: administradores e o SGI enxergam tudo; os demais usuários enxergam apenas os documentos da sua unidade e do seu cargo. Isso é automático, pelo cadastro do usuário.

## Como ele avisa os vencimentos

O aviso é 100% automático, por e-mail. Funciona assim:

**Todo dia às 5h da manhã (horário de Brasília)** um robô do sistema percorre a lista inteira de documentos ativos e calcula quantos dias faltam para cada um vencer.

**O aviso padrão sai com 30, 15, 7 e 1 dia de antecedência** (esse padrão pode ser alterado documento a documento no cadastro, no campo "Avisar com"). Se o documento **já venceu**, o sistema manda e-mail **todos os dias** até alguém renovar ou inativar — ele não deixa esquecer.

**Quem recebe:** o responsável cadastrado no documento (destinatário principal) com os administradores em cópia. Se o documento não tiver responsável com e-mail, vai só para os administradores.

**O que vem no e-mail:** nome, tipo, unidade, responsável e data de vencimento do documento, um botão "Abrir documento" (link ou arquivo) e um botão verde **"Já renovei — atualizar data"**. Esse botão é o pulo do gato: ele abre uma página onde a pessoa informa a nova data e **anexa obrigatoriamente o arquivo renovado** — o sistema atualiza sozinho, sem precisar entrar no Central SGI nem pedir para ninguém. O link é individual e protegido por código, então só quem recebeu o e-mail consegue usar.

O sistema também registra tudo que enviou (histórico das últimas 60 verificações) e nunca manda o mesmo aviso duas vezes no mesmo dia. Além do robô diário, o botão **"▶ Verificar agora"** na tela dispara a checagem manualmente a qualquer momento.

## Como eu incluo um documento

Na aba **Gestão de documentos internos → Vencimentos**, clique no botão verde **"＋ Novo documento"** e preencha:

1. **Unidade** — onde o documento vale.
2. **Nome e tipo** — o tipo tem sugestões prontas (ASO, Alvará, ISO 9001…), mas aceita qualquer texto.
3. **Responsável e e-mail** — ao digitar o nome de um usuário do sistema, o e-mail e o cargo preenchem sozinhos. É esse e-mail que recebe os avisos.
4. **Data de vencimento e status** — a data é obrigatória.
5. **Avisar com (dias antes)** — já vem "30, 15, 7, 1"; mude se quiser.
6. **O documento em si** — anexe o arquivo **ou** cole um link de pasta/documento (Drive etc.). Se anexar vários arquivos de uma vez, o sistema cria um cadastro por arquivo (o nome vem do nome do arquivo; depois é só ajustar tipo e responsável em cada um).

Clique em **Salvar documento**. Pronto — a partir daí o robô diário cuida dos avisos. Na tabela, cada linha tem três ações: **↻ Renovar** (informa a nova data), **✏️ editar** e **🗑 excluir**.

## Qualquer pessoa entende? Avaliação honesta

O fluxo central é bom: quem recebe o e-mail não precisa saber usar o sistema — clica no botão, anexa o arquivo novo, informa a data e acabou. Essa é a parte mais acessível do projeto.

Já a tela tem pontos que confundem quem não é do SGI, e são exatamente os que estamos redesenhando nos protótipos: os contadores coloridos parecem botões mas não filtram nada; a busca não encontra "Alvará" se digitarem "alvara"; a data aparece no formato americano (2026-08-15); com filtros ativos não fica claro por que a lista "sumiu"; o formulário de cadastro é uma coluna longa de campos sem agrupamento; e no celular a tabela de 9 colunas fica inutilizável. Com as melhorias aprovadas (contadores clicáveis, busca sem acento, datas em português, avisos de filtro, formulário em seções, cartões no celular, matriz por unidade e painel de condicionantes da LO), a resposta passa a ser sim — qualquer pessoa entende.

## Detalhes técnicos (para quem mantém o sistema)

Os documentos ficam gravados no banco (chave `documentos_vencimento` no Redis/Upstash); os arquivos anexados vão para o Supabase Storage (bucket `terceiros-docs`, pasta `docint/`). A verificação diária roda pelo cron da Vercel (`/api/portal-cron`, 08:00 UTC), que chama `lib/docint.js`. Os e-mails saem pela conta Gmail configurada no servidor. A renovação por link usa token individual por documento (`renew.html` + `/api/renew_document`), que exige data nova e arquivo anexado, zera o histórico de avisos e reativa o documento. O acesso por unidade+cargo é aplicado no servidor (`api/terc.js`, função `docintScope`), não apenas na tela.
