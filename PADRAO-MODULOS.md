# Padrão para inserir módulos no sistema (Central SGI · METIS)

> **REGRA PRINCIPAL — cabeçalho:** todo módulo carregado dentro do sistema (via iframe no `index.html`)
> **NÃO pode exibir o próprio cabeçalho de marca** (logo METIS + título). O `index.html` já mostra o
> cabeçalho e o breadcrumb. Antes de inserir qualquer módulo novo, **verifique se ele tem cabeçalho
> próprio e remova/oculte-o quando embutido.** Isso evita cabeçalho duplicado e perda de espaço na tela.

O jeito padrão de cumprir a regra é o módulo **detectar sozinho que está embutido** e esconder a barra
de marca, mantendo apenas os botões de ação num filete fino.

---

## Checklist para adicionar um módulo novo

1. **Criar o arquivo do módulo** (`meu-modulo.html`), com a identidade METIS.
2. **Aplicar a regra do cabeçalho** (trecho abaixo) — obrigatório.
3. **Registrar no `index.html`:**
   - item de menu (`nav-item` ou `nav-item-sub`) chamando `navigate('meumodulo', this)`;
   - página + iframe: `<div class="page" id="page-meumodulo">…<iframe id="meumodulo-frame">…</div>`;
   - caso no `navigate()` que faz `frame.src = 'meu-modulo.html'` na primeira abertura;
   - rótulo no objeto `pages` (para o breadcrumb).
4. **Testar embutido**: abrir pelo menu e confirmar que só existe **um** cabeçalho METIS na tela.

---

## Trecho obrigatório (regra do cabeçalho)

Cole no CSS do módulo (dentro do `<style>`):

```css
/* Dentro do sistema (iframe): o cabeçalho METIS já é do index — remove a barra da marca, mantém só os botões. */
body.embedded .top{position:static;background:transparent;border-bottom:none;box-shadow:none;backdrop-filter:none;padding:8px 18px 0}
body.embedded .top .logo,body.embedded .top h1{display:none}
body.embedded .wrap{padding-top:4px}
body.embedded .aside{top:14px}
```

E no início do `<script>` (antes de renderizar a tela):

```js
try{ if(window.self!==window.top) document.body.classList.add('embedded'); }
catch(e){ document.body.classList.add('embedded'); }
```

> Ajuste os seletores (`.top`, `.logo`, `.top h1`, `.wrap`, `.aside`) para os nomes usados no seu módulo.
> A ideia é sempre a mesma: **quando `body.embedded`, esconder a marca/título e deixar só as ações.**

---

## Observações

- Aberto de forma avulsa (fora do sistema), o módulo continua mostrando o cabeçalho completo — a regra
  só age quando ele está dentro de um iframe.
- Botões de ação (Salvar, Importar, Exportar) permanecem visíveis num filete discreto à direita.
- Se o módulo salva automaticamente a cada alteração, o botão "Salvar" é apenas conforto e pode ser
  ocultado também quando embutido.

## Módulos que já seguem o padrão
- `ip-mcr.html` — Mapa de Processos (IP & MCR)
- `escopo.html` — Escopo · Auditoria
