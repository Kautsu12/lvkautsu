// Tema claro/escuro compartilhado (login, portal, portal_docs)
(function(){
  function ap(t){ document.body.classList.toggle('dark', t==='dark'); var b=document.getElementById('thBtn'); if(b) b.textContent = t==='dark'?'☀️':'🌙'; }
  window.tgTheme=function(){ var c=(localStorage.getItem('user_theme')==='dark')?'light':'dark'; try{localStorage.setItem('user_theme',c);}catch(e){} ap(c); };
  ap((function(){try{return localStorage.getItem('user_theme')||'light';}catch(e){return 'light';}})());
})();
