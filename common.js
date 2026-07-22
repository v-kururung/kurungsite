/* ═══════════════════════════════════════════
   공통 기능 — config.js 를 읽어 사이트를 구성
   (이 파일은 수정하지 않아도 됩니다)
   ═══════════════════════════════════════════ */

var CFG = window.SITE_CONFIG || {};

/* ───── 유틸 ───── */
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
/* {name} 등 치환 */
function fullName(){
  var p=CFG.profile||{};
  return (p.nameMain||'')+(p.nameAccent||'');
}
function T(s){
  return String(s==null?'':s)
    .replace(/\{name\}/g, fullName())
    .replace(/\{nameMain\}/g, (CFG.profile||{}).nameMain||'')
    .replace(/\{year\}/g, String(new Date().getFullYear()));
}

function hexA(hex,a){
  var h=String(hex||'').replace('#','');
  if(h.length===3) h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var n=parseInt(h,16);
  return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
}

/* ───── 테마 적용 ───── */
function applyTheme(){
  var t=CFG.theme||{}, f=CFG.fonts||{}, r=document.documentElement.style;
  r.setProperty('--pink',       t.main);
  r.setProperty('--pink-deep',  t.mainDeep);
  r.setProperty('--pink-soft',  t.mainSoft);
  r.setProperty('--accent',     t.accent);
  r.setProperty('--accent-soft',t.accentSoft);
  r.setProperty('--sub2',       t.sub2);
  r.setProperty('--page',       t.page);
  r.setProperty('--card',       t.card);
  r.setProperty('--ink',        t.text);
  r.setProperty('--sub',        t.textSub);
  r.setProperty('--line',       t.line);

  /* 파생 색상 */
  r.setProperty('--page-blur',    hexA(t.page,.82));
  r.setProperty('--pink-glow',    hexA(t.main,.25));
  r.setProperty('--shadow',       '0 18px 44px '+hexA(t.mainDeep,.18));
  r.setProperty('--arw-shadow',   '0 6px 16px '+hexA(t.mainDeep,.35));
  r.setProperty('--today-bg',     'linear-gradient(155deg,'+t.main+','+t.mainDeep+')');
  r.setProperty('--today-shadow', '0 14px 28px '+hexA(t.mainDeep,.45));
  r.setProperty('--special-bg',   'linear-gradient(160deg,'+t.accentSoft+','+t.accent+')');
  r.setProperty('--special-ink',  '#7a5a12');
  r.setProperty('--portrait-bg',  'radial-gradient(120% 110% at 50% 20%,'+t.accentSoft+','+t.mainSoft+')');
  r.setProperty('--sat',          '#d99a3c');

  /* 폰트 */
  r.setProperty('--disp',  '"'+f.display+'",sans-serif');
  r.setProperty('--body',  '"'+f.body+'",sans-serif');
  r.setProperty('--hand',  '"'+f.hand+'",cursive');
  r.setProperty('--latin', '"'+f.latin+'",sans-serif');

  /* 구글 폰트 로드 */
  var fam=[f.display,f.body,f.hand].filter(Boolean)
          .map(function(n){return 'family='+n.replace(/ /g,'+');}).join('&');
  if(f.latin) fam+='&family='+f.latin.replace(/ /g,'+')+':wght@500;600';
  var link=document.createElement('link');
  link.rel='stylesheet';
  link.href='https://fonts.googleapis.com/css2?'+fam+'&display=swap';
  document.head.appendChild(link);

  document.title = T((CFG.site&&CFG.site.tabTitle) || '');
}

/* ───── 상단바 · 푸터 ───── */
function renderChrome(activeHref){
  var s=CFG.site||{}, menu=CFG.menu||[];
  var items=menu.map(function(m){
    var on=(m.href===activeHref)?' class="on"':'';
    return '<a href="'+esc(m.href)+'"'+on+'>'+esc(m.label)+'</a>';
  }).join('');

  var header=document.querySelector('header.top');
  if(header) header.innerHTML='<div class="wrap">'+
    '<a href="'+esc(menu[0]?menu[0].href:'index.html')+'" class="logo">'+esc(T(s.logoText))+'</a>'+
    '<nav class="menu">'+items+'</nav></div>';

  var footer=document.querySelector('footer');
  if(footer){
    var line=esc(T(s.footer));
    if(s.credit){
      var c = s.creditUrl
        ? '<a href="'+esc(s.creditUrl)+'" target="_blank" rel="noopener">'+esc(T(s.credit))+'</a>'
        : esc(T(s.credit));
      line += '<span class="sep">·</span><span class="credit">'+c+'</span>';
    }
    footer.innerHTML='<div class="wrap"><div class="cloud">☁ ✦ ☁</div><p>'+line+'</p></div>';
  }
}

/* ───── 배경 반짝임 ───── */
function initSparkles(){
  var e=CFG.effects||{};
  if(!e.enabled) return;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var sky=document.getElementById('sky'); if(!sky) return;
  var g=e.glyphs||['✦'], t=CFG.theme||{};
  for(var i=0;i<(e.count||12);i++){
    var s=document.createElement('span');
    s.className='spark';
    s.textContent=g[i%g.length];
    s.style.left=(Math.random()*100)+'%';
    s.style.fontSize=(11+Math.random()*16)+'px';
    s.style.color=i%2?t.main:t.accent;
    s.style.animationDuration=(11+Math.random()*10)+'s';
    s.style.animationDelay=(-Math.random()*18)+'s';
    sky.appendChild(s);
  }
}

/* ───── 데이터 연결 (Cloudflare Pages Functions) ───── */
var API = (CFG.apiBase || '/api').replace(/\/$/, '');

var DB = {
  /* 관리자 토큰 (admin 페이지에서 저장) */
  token: function(){ try{ return localStorage.getItem('adminToken')||''; }catch(e){ return ''; } },

  headers: function(json){
    var h = {};
    if(json) h['Content-Type']='application/json';
    var t=DB.token(); if(t) h['X-Admin-Token']=t;
    return h;
  },

  list: async function(table){
    var r = await fetch(API+'/'+table, { headers: DB.headers(false) });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  },

  insert: async function(table, row){
    var r = await fetch(API+'/'+table, {
      method:'POST', headers: DB.headers(true), body: JSON.stringify(row)
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  },

  update: async function(table, id, row){
    var r = await fetch(API+'/'+table+'/'+id, {
      method:'PUT', headers: DB.headers(true), body: JSON.stringify(row)
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  },

  remove: async function(table, id){
    var r = await fetch(API+'/'+table+'/'+id, {
      method:'DELETE', headers: DB.headers(false)
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  },

  upload: async function(file){
    var fd = new FormData(); fd.append('file', file);
    var h = {}; var t=DB.token(); if(t) h['X-Admin-Token']=t;
    var r = await fetch(API+'/upload', { method:'POST', headers:h, body: fd });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();       /* { url, key } */
  }
};

/* ───── 문의창 ───── */
function buildInquiry(){
  var q=CFG.inquiry||{};
  var el=document.createElement('div');
  el.className='ov'; el.id='iqOv';
  el.innerHTML='<div class="modal">'+
    '<h3>'+esc(T(q.title))+'</h3>'+
    '<div class="d">'+esc(T(q.description))+'</div>'+
    '<input id="iqNick" placeholder="'+esc(T(q.nickLabel))+'">'+
    '<input id="iqContact" placeholder="'+esc(T(q.contactLabel))+'">'+
    '<textarea id="iqMsg" rows="4" placeholder="'+esc(T(q.messageLabel))+'"></textarea>'+
    '<div class="astat" id="iqStat"></div>'+
    '<div class="mbtns">'+
      '<button class="c" onclick="closeInquiry()">취소</button>'+
      '<button class="s" onclick="sendInquiry()">'+esc(q.sendLabel)+'</button>'+
    '</div></div>';
  el.addEventListener('click',function(e){ if(e.target===el) closeInquiry(); });
  document.body.appendChild(el);
}
function openInquiry(){
  var o=document.getElementById('iqOv'); if(!o) return;
  o.classList.add('on'); document.getElementById('iqNick').focus();
}
function closeInquiry(){
  var o=document.getElementById('iqOv'); if(!o) return;
  o.classList.remove('on');
  var s=document.getElementById('iqStat'); if(s) s.textContent='';
}
async function sendInquiry(){
  var q=CFG.inquiry||{};
  var n=(document.getElementById('iqNick').value||'').trim();
  var c=(document.getElementById('iqContact').value||'').trim();
  var m=(document.getElementById('iqMsg').value||'').trim();
  var st=document.getElementById('iqStat');
  if(!n){ st.textContent='닉네임을 입력해 주세요!'; return; }
  if(!m){ st.textContent='문의 내용을 적어주세요!'; return; }
  st.textContent='보내는 중…';
  try{
    await DB.insert('inquiries',{nickname:n, contact:c, message:m});
    st.textContent=q.doneText||'보냈어요!';
    document.getElementById('iqNick').value='';
    document.getElementById('iqContact').value='';
    document.getElementById('iqMsg').value='';
    setTimeout(closeInquiry,1400);
  }catch(e){ st.textContent='전송 실패 ㅠㅠ 잠시 후 다시 시도해 주세요'; }
}

/* ───── 링크 버튼 ───── */
function renderLinks(sel){
  var box=document.querySelector(sel); if(!box) return;
  box.innerHTML=(CFG.links||[]).map(function(l){
    var icon=/\.(png|jpg|jpeg|svg|webp|gif)$/i.test(l.icon)
      ? '<img class="ic" src="'+esc(l.icon)+'" alt="">'
      : '<span class="ic">'+esc(l.icon)+'</span>';
    if(l.url==='inquiry')
      return '<a href="#" onclick="openInquiry();return false;">'+icon+esc(l.label)+'</a>';
    return '<a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+icon+esc(l.label)+'</a>';
  }).join('');
}

/* ───── 페이지 공통 초기화 ───── */
function initPage(activeHref){
  applyTheme();
  renderChrome(activeHref);
  buildInquiry();
  initSparkles();
}
