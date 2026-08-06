/* ═══════════════════════════════════════════════════════════
   프로필 항목 편집 — admin.html 의 🧝 프로필 탭에 붙습니다.

   저장 위치는 settings 표의 두 칸입니다.
     profile_rows   : 항목 목록 (JSON)
     profile_bubble : 말풍선 문구
   따로 만들 표는 없습니다.
   ═══════════════════════════════════════════════════════════ */

(function () {
  var say = function (m) { if (typeof toast === 'function') toast(m); else console.log(m); };

  var rows = [];
  var bubble = '';
  var loaded = false;

  var esc2 = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ───── 화면 ───── */

  function mount() {
    var panel = document.getElementById('p-profile');
    if (!panel || document.getElementById('prBox')) return;

    var box = document.createElement('div');
    box.className = 'box';
    box.id = 'prBox';
    box.innerHTML = [
      '<h3>프로필 항목</h3>',
      '<p class="pr-help">항목 이름과 내용을 자유롭게 바꿀 수 있어요. ' +
      '<b>강조</b>는 값을 포인트 색으로, <b>D-day</b>는 값 옆에 데뷔 며칠째 뱃지를 붙입니다.</p>',
      '<div id="prList" class="pr-list"></div>',
      '<button class="btn sub pr-add" id="prAdd" type="button">＋ 항목 추가</button>',
      '<div class="pr-bubble">',
      '  <label class="pr-cap">말풍선 문구</label>',
      '  <input id="prBubble" placeholder="비워두면 말풍선이 숨겨져요" autocomplete="off">',
      '</div>',
      '<div class="actions">',
      '  <span class="stat" id="prStat"></span>',
      '  <button class="btn sub" id="prReset" type="button">되돌리기</button>',
      '  <button class="btn" id="prSave" type="button">저장하기</button>',
      '</div>',
    ].join('');
    panel.appendChild(box);

    document.getElementById('prAdd').addEventListener('click', function () {
      rows.push({ key: '', value: '', highlight: false, dday: false });
      render();
      var last = document.querySelector('#prList .pr-row:last-child input');
      if (last) last.focus();
    });
    document.getElementById('prSave').addEventListener('click', save);
    document.getElementById('prReset').addEventListener('click', function () { load(true); });

    load();
  }

  function render() {
    var wrap = document.getElementById('prList');
    if (!wrap) return;

    if (rows.length === 0) {
      wrap.innerHTML = '<p class="pr-empty">항목이 없어요. 아래 버튼으로 추가해 주세요.</p>';
      return;
    }

    wrap.innerHTML = rows.map(function (r, i) {
      return '<div class="pr-row" data-i="' + i + '">' +
        '<div class="pr-move">' +
        '  <button type="button" data-mv="-1" title="위로"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
        '  <button type="button" data-mv="1" title="아래로"' + (i === rows.length - 1 ? ' disabled' : '') + '>▼</button>' +
        '</div>' +
        '<input class="pr-k" data-f="key" value="' + esc2(r.key) + '" placeholder="항목명 (예: 종족)">' +
        '<input class="pr-v" data-f="value" value="' + esc2(r.value) + '" placeholder="내용 (예: 선녀)">' +
        '<label class="pr-chk"><input type="checkbox" data-f="highlight"' + (r.highlight ? ' checked' : '') + '>강조</label>' +
        '<label class="pr-chk"><input type="checkbox" data-f="dday"' + (r.dday ? ' checked' : '') + '>D-day</label>' +
        '<button type="button" class="pr-del" title="삭제">✕</button>' +
        '</div>';
    }).join('');

    wrap.querySelectorAll('.pr-row').forEach(function (el) {
      var i = Number(el.dataset.i);

      el.querySelectorAll('input[data-f]').forEach(function (inp) {
        var f = inp.dataset.f;
        inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', function () {
          rows[i][f] = inp.type === 'checkbox' ? inp.checked : inp.value;
          dirty();
        });
      });

      el.querySelectorAll('button[data-mv]').forEach(function (b) {
        b.addEventListener('click', function () {
          var j = i + Number(b.dataset.mv);
          if (j < 0 || j >= rows.length) return;
          var tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
          render(); dirty();
        });
      });

      el.querySelector('.pr-del').addEventListener('click', function () {
        rows.splice(i, 1);
        render(); dirty();
      });
    });
  }

  function dirty() {
    var s = document.getElementById('prStat');
    if (s) s.textContent = '저장하지 않은 변경이 있어요';
  }

  /* ───── 불러오기 · 저장 ───── */

  async function load(force) {
    if (loaded && !force) { render(); return; }
    var stat = document.getElementById('prStat');
    if (stat) stat.textContent = '불러오는 중…';

    var st = {};
    try { st = (await DB.settings()) || {}; } catch (e) { }

    rows = null;
    if (st.profile_rows) {
      try {
        var saved = JSON.parse(st.profile_rows);
        if (Array.isArray(saved)) rows = saved;
      } catch (e) { }
    }
    /* 저장한 적이 없으면 config.js 의 기본값을 옮겨옵니다 */
    if (!rows) rows = ((CFG.profile || {}).rows || []).map(function (r) {
      return { key: r.key || '', value: r.value || '', highlight: !!r.highlight, dday: !!r.dday };
    });

    bubble = st.profile_bubble != null && st.profile_bubble !== ''
      ? st.profile_bubble
      : ((CFG.profile || {}).bubble || '');

    var b = document.getElementById('prBubble');
    if (b) b.value = bubble;

    loaded = true;
    render();
    if (stat) stat.textContent = '';
  }

  async function save() {
    var stat = document.getElementById('prStat');
    var clean = rows
      .map(function (r) {
        return {
          key: String(r.key || '').trim(),
          value: String(r.value || '').trim(),
          highlight: !!r.highlight,
          dday: !!r.dday,
        };
      })
      .filter(function (r) { return r.key || r.value; });

    stat.textContent = '저장 중…';
    try {
      await DB.saveSetting('profile_rows', JSON.stringify(clean));
      await DB.saveSetting('profile_bubble', document.getElementById('prBubble').value.trim());
      rows = clean;
      render();
      stat.textContent = '';
      say('프로필을 저장했어요 🌿');
    } catch (e) {
      stat.textContent = '저장 실패 — ' + e.message;
    }
  }

  /* 탭을 열 때 준비합니다 */
  var origTab = window.tab;
  window.tab = function (n) {
    if (typeof origTab === 'function') origTab(n);
    if (n === 'profile') mount();
  };

  /* ───── 스타일 ───── */

  var css = document.createElement('style');
  css.textContent = [
    '.pr-help{font-size:13px;color:#6b7684;margin:-4px 0 14px}',
    '.pr-list{display:flex;flex-direction:column;gap:6px}',
    '.pr-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;',
    'border:1px solid #e5e8eb;background:#fff;transition:border-color .12s}',
    '.pr-row:hover{border-color:#d1d6db}',
    '.pr-move{display:flex;flex-direction:column;gap:1px;flex:0 0 auto}',
    '.pr-move button{border:0;background:none;color:#b0b8c1;font-size:9px;line-height:1;',
    'cursor:pointer;padding:2px 3px}',
    '.pr-move button:hover:not(:disabled){color:#3182f6}',
    '.pr-move button:disabled{opacity:.3;cursor:default}',
    '.pr-row input[type=text],.pr-row input:not([type]){padding:8px 11px;border:1px solid #e5e8eb;',
    'border-radius:8px;font:inherit;font-size:13px;color:#333d4b;min-width:0}',
    '.pr-row .pr-k{flex:0 0 130px}',
    '.pr-row .pr-v{flex:1}',
    '.pr-chk{display:flex;align-items:center;gap:4px;font-size:12px;color:#6b7684;',
    'white-space:nowrap;cursor:pointer;flex:0 0 auto}',
    '.pr-del{border:0;background:none;color:#b0b8c1;font-size:13px;cursor:pointer;padding:4px 6px;flex:0 0 auto}',
    '.pr-del:hover{color:#d64545}',
    '.pr-add{margin-top:10px}',
    '.pr-empty{text-align:center;color:#8b95a1;padding:22px 0;font-size:13px}',
    '.pr-bubble{margin-top:18px;padding-top:16px;border-top:1px solid #f2f4f6}',
    '.pr-cap{display:block;font-size:12px;color:#8b95a1;margin-bottom:6px}',
    '.pr-bubble input{width:100%;padding:9px 12px;border:1px solid #e5e8eb;border-radius:8px;',
    'font:inherit;font-size:14px;color:#333d4b}',
    '@media(max-width:720px){',
    '  .pr-row{flex-wrap:wrap}',
    '  .pr-row .pr-k,.pr-row .pr-v{flex:1 1 100%}',
    '}',
  ].join('');
  document.head.appendChild(css);
})();