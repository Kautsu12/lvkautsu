import { Redis } from '@upstash/redis';

const LOGIN_PAGE = '/login.html';
// SEGURANCA: /api/save e /api/load NAO sao publicas — sao usadas apenas pelas paginas internas
// (atras de login). Deixa-las publicas permitia ler/escrever QUALQUER chave do Redis sem sessao.
// /api/backup fica publica por ser alvo de cron e ter autenticacao propria (segredo do cron).
const PUBLIC_PATHS = ['/login.html', '/assets', '/api/auth', '/api/backup', '/api/renew_document', '/renew.html', '/rnc.html', '/favicon.ico', '/portal.html', '/portal_docs.html', '/api/portal-auth', '/api/portal-docs', '/api/portal-upload', '/api/portal-invite', '/api/portal-cron', '/cumprir.html', '/api/condlo'];

const REDIS_URL   = (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '').trim().replace(/^["']|["']$/g, '');
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');

// Match exato OU prefixo de diretorio — evita que "/login.htmlXYZ" seja considerado publico.
function isPublic(pathname) {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const c of header.split(';')) {
    const i = c.indexOf('=');
    if (i === -1) continue;
    if (c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return '';
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Rotas publicas — deixa passar
  if (isPublic(pathname)) return;

  // Sessao server-side: token aleatorio no cookie -> registro no Redis.
  // (O formato antigo "segredo:user", com ':', e' explicitamente rejeitado.)
  const token = getCookie(request, 'raitz_session');
  if (token && token.indexOf(':') === -1 && REDIS_URL && REDIS_TOKEN) {
    try {
      const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
      const sess = await redis.get('sgi_session:' + token);
      if (sess) return; // autenticado
    } catch (_) { /* em erro de Redis, cai no redirect abaixo */ }
  }

  // Nao autenticado -> redireciona para login (apenas caminho relativo no parametro)
  const loginUrl = new URL(LOGIN_PAGE, request.url);
  loginUrl.searchParams.set('redirect', pathname);
  return Response.redirect(loginUrl.toString(), 302);
}

export const config = {
  matcher: '/((?!_vercel|favicon.ico).*)',
};
