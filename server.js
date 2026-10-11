/* =====================================================================
   Chispi — servidor mínimo (Node 18+, SIN dependencias externas)
   1) Sirve la PWA estática
   2) Proxy /api/chat con CADENA DE PROVEEDORES y fallback automático:
      Anthropic (Claude) → Google Gemini → Groq → OpenRouter → OpenAI.
      Las claves viven SOLO en variables de entorno (Render), nunca en código.
      Si un proveedor falla, satura cuota o se queda sin crédito, se le
      pone en "enfriamiento" y la petición pasa al siguiente automáticamente.
   ===================================================================== */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const env  = k => (process.env[k] || '').trim();

/* ---------- cadena de proveedores (orden = prioridad) ---------- */
const PROVS = [];
function add(name,label,keys,model,defModel,url,extra){
  keys.filter(Boolean).forEach((key,i) => {
    PROVS.push({ name:name, label:label + (i>0 ? '·'+ (i+1) : ''),
      key:key, model:model || defModel, url:url, extraHeaders:extra || null,
      downUntil:0, fails:0 });
  });
}
/* 1) Anthropic (Claude) — hasta 3 claves de respaldo */
add('anthropic','anthropic',
  [env('AI_API_KEY'), env('AI_API_KEY_2'), env('AI_API_KEY_3')],
  env('AI_MODEL'),'claude-haiku-4-5-20251001',
  env('AI_URL') || 'https://api.anthropic.com/v1/messages');
/* 2) Google Gemini (tiene nivel gratuito) */
add('gemini','gemini',
  [env('GEMINI_API_KEY'), env('GEMINI_API_KEY_2')],
  env('GEMINI_MODEL'),'gemini-2.5-flash-lite',
  'https://generativelanguage.googleapis.com/v1beta/models/{M}:generateContent');
/* 3) Groq (gratis y rapidísimo, API OpenAI-compatible) */
add('openai','groq',
  [env('GROQ_API_KEY'), env('GROQ_API_KEY_2')],
  env('GROQ_MODEL'),'llama-3.1-8b-instant',
  'https://api.groq.com/openai/v1/chat/completions');
/* 4) OpenRouter (modelos ":free" gratis) */
add('openai','openrouter',
  [env('OPENROUTER_API_KEY'), env('OPENROUTER_API_KEY_2')],
  env('OPENROUTER_MODEL'),'meta-llama/llama-3.3-70b-instruct:free',
  'https://openrouter.ai/api/v1/chat/completions',
  { 'HTTP-Referer':'https://chispi.onrender.com', 'X-Title':'Chispi' });
/* 5) OpenAI (de pago, último recurso) */
add('openai','openai',
  [env('OPENAI_API_KEY')],
  env('OPENAI_MODEL'),'gpt-4o-mini',
  'https://api.openai.com/v1/chat/completions');

/* ---------- llamadas por proveedor ---------- */
function Ab(ms){ return (typeof AbortSignal!=='undefined' && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined; }
function httpErr(status,j){
  const e = new Error('http_'+status); e.status = status;
  e.msg = (j && j.error && (j.error.message || j.error.type)) || '';
  return e;
}
async function callAnthropic(p,sys,msgs){
  const r = await fetch(p.url, { method:'POST',
    headers:{ 'content-type':'application/json', 'x-api-key':p.key, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:p.model, max_tokens:170, system:sys, messages:msgs }),
    signal: Ab(10000) });
  const j = await r.json().catch(()=>null);
  if(!r.ok) throw httpErr(r.status,j);
  const t = j && j.content && j.content[0] && j.content[0].text;
  if(!t) throw new Error('empty');
  return t;
}
async function callGemini(p,sys,msgs){
  const url = p.url.replace('{M}', encodeURIComponent(p.model)) + '?key=' + encodeURIComponent(p.key);
  const body = {
    contents: msgs.map(m => ({ role: m.role==='assistant' ? 'model' : 'user',
                                parts:[{ text:m.content }] })),
    generationConfig: { maxOutputTokens:170, temperature:0.9 }
  };
  if(sys) body.systemInstruction = { parts:[{ text:sys }] };
  const r = await fetch(url, { method:'POST',
    headers:{ 'content-type':'application/json' },
    body: JSON.stringify(body), signal: Ab(10000) });
  const j = await r.json().catch(()=>null);
  if(!r.ok) throw httpErr(r.status,j);
  const c = j && j.candidates && j.candidates[0];
  const t = c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text;
  if(!t) throw new Error('empty');
  return t;
}
async function callOpenAIStyle(p,sys,msgs){
  const headers = { 'content-type':'application/json', 'authorization':'Bearer ' + p.key };
  if(p.extraHeaders) Object.assign(headers, p.extraHeaders);
  const r = await fetch(p.url, { method:'POST', headers:headers,
    body: JSON.stringify({ model:p.model, max_tokens:170,
      messages: [{role:'system',content:sys}].concat(msgs) }),
    signal: Ab(10000) });
  const j = await r.json().catch(()=>null);
  if(!r.ok) throw httpErr(r.status,j);
  const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if(!t) throw new Error('empty');
  return t;
}

/* ---------- failover: prueba en orden, se salta los caídos ---------- */
async function askAI(sys,msgs){
  const now = Date.now();
  const vivos = PROVS.filter(p => p.downUntil <= now);
  const orden = vivos.concat(PROVS.filter(p => p.downUntil > now));  // vivos primero
  let lastErr = null;
  for(const p of orden){
    try{
      let t;
      if(p.name === 'anthropic')      t = await callAnthropic(p, sys, msgs);
      else if(p.name === 'gemini')    t = await callGemini(p, sys, msgs);
      else                            t = await callOpenAIStyle(p, sys, msgs);
      p.fails = 0; p.downUntil = 0;
      return { text:String(t).slice(0,1200), via:p.label };
    }catch(e){
      lastErr = e;
      p.fails++;
      const st = e.status || 0;
      const agotado = (st===401 || st===402 || st===403) ||
                      /quota|billing|credit|insufficient|exhausted/i.test(e.msg || '');
      /* enfriamiento: sin crédito → 6 h; saturado/error → 10 min (30 si reincide) */
      p.downUntil = Date.now() + (agotado ? 6*3600e3 : (p.fails >= 3 ? 1800e3 : 600e3));
      console.log('[' + p.label + '] caído (' + (e.message||'err') + ') → fallback');
    }
  }
  throw lastErr || new Error('no_providers');
}

/* ---------- anti-abusos: 30 peticiones/minuto por IP ---------- */
const RL = new Map();
function rateOk(ip){
  const now = Date.now();
  let e = RL.get(ip);
  if(!e || now > e.reset){ e = { n:0, reset:now+60000 }; RL.set(ip,e); }
  e.n++; if(RL.size > 5000) RL.clear();
  return e.n <= 30;
}
function readBody(req){ return new Promise((res,rej)=>{
  let s='';
  req.on('data', c => { s += c; if(s.length > 65536){ rej(new Error('big')); req.destroy(); } });
  req.on('end', () => { try{ res(s ? JSON.parse(s) : {}); }catch(e){ rej(e); } });
  req.on('error', rej);
});}
function send(res, code, obj){
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.ico':'image/x-icon', '.css':'text/css; charset=utf-8',
  '.webmanifest':'application/manifest+json'
};

const server = http.createServer(async (req,res) => {
  try{
    const u = new URL(req.url, 'http://localhost');

    if(u.pathname === '/api/health'){
      send(res,200,{ ok:true,
        providers: PROVS.map(p => ({ name:p.label, model:p.model, down:p.downUntil > Date.now() })) });
      return;
    }
    if(u.pathname === '/api/chat' && req.method === 'POST'){
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x');
      if(!rateOk(ip)){ send(res,200,{error:'rate'}); return; }
      if(!PROVS.length){ send(res,200,{error:'no_key'}); return; }
      let body;
      try{ body = await readBody(req); }catch(e){ send(res,200,{error:'bad_body'}); return; }
      const msgs = Array.isArray(body.msgs) ? body.msgs.slice(-8).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0,600)
      })) : [];
      if(!msgs.length){ send(res,200,{error:'empty'}); return; }
      try{
        const out = await askAI(String(body.sys || '').slice(0,1500), msgs);
        send(res,200, out);
      }catch(e){ send(res,200,{error:'ai_fail'}); }
      return;
    }

    /* estáticos */
    let p = decodeURIComponent(u.pathname);
    if(p === '/' || p === '') p = '/index.html';
    p = path.normalize(p).replace(/^([\/\\])+/, '');
    const fp = path.join(__dirname, p);
    if(fp.indexOf(__dirname) !== 0){ res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err,data) => {
      if(err){ res.writeHead(404,{'Content-Type':'text/plain'}); res.end('404'); return; }
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
      });
      res.end(data);
    });
  }catch(e){ res.writeHead(500); res.end(); }
});
server.listen(PORT, () =>
  console.log('Chispi en puerto ' + PORT + ' | proveedores IA: ' +
    (PROVS.length ? PROVS.map(p => p.label + '(' + p.model + ')').join(', ') : 'ninguno (modo local)')));
