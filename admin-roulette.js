/* ═══════════════════════════════════════════════════════════
   룰렛 숙제 관리 — admin.html 의 🎯 룰렛 숙제 탭

   admin.html 에는 이미 아래 세 가지가 들어가 있습니다.
     · 탭 버튼   <button data-t="roulette" onclick="tab('roulette')">
     · 패널 자리 <div class="panel" id="p-roulette"></div>
     · 스크립트  <script src="admin-roulette.js"></script>

   이미지 첨부에는 컬럼이 하나 필요합니다.
     ALTER TABLE roulette_items ADD COLUMN image_url TEXT;
   ═══════════════════════════════════════════════════════════ */

(function () {
  var ROOT = (typeof API !== 'undefined' ? API : '/api');
  var BASE = ROOT + '/roulette';
  var UPLOAD = ROOT + '/upload';

  var PAGE = 100;   /* 한 번에 불러올 후원 수 — 넘칠 때만 '더 보기'가 뜹니다 */

  var token = function () {
    if (typeof DB !== 'undefined' && DB.token) return DB.token();
    return localStorage.getItem('adminToken') || '';
  };
  var say = function (m) { if (typeof toast === 'function') toast(m); else console.log(m); };

  /* 시청자 방송국 주소 — https://www.sooplive.com/station/<아이디> */
  var station = function (id) { return 'https://www.sooplive.com/station/' + encodeURIComponent(id); };

  var KIND = { instant: '즉시', task: '숙제', meta: '제외', coupon: '쿠폰', unknown: '미분류' };
  var STATUS = { pending: '대기', scheduled: '예정', done: '완료', void: '제외', held: '보유', used: '사용' };

  var state = {
    status: 'pending', q: '', offset: 0,
    orders: [], hasMore: false, menu: [], menuOpen: false,
    pick: null,     /* 지금 고른 항목 (order_idx::seq) */
    manual: [],     /* 수동 등록에 담은 룰렛 결과 */
    image: '',      /* 첨부한 이미지 주소 */
  };

  var dock;         /* 처리 바 — 목록을 다시 그려도 살아남도록 따로 들고 있습니다 */

  /* ───── 통신 ───── */

  async function api(path, opts) {
    var o = opts || {};
    var res = await fetch(BASE + path, {
      method: o.method || 'GET',
      headers: Object.assign({ 'X-Admin-Token': token() }, o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async function upload(file) {
    var fd = new FormData();
    fd.append('file', file, file.name || 'paste.png');
    var res = await fetch(UPLOAD, { method: 'POST', headers: { 'X-Admin-Token': token() }, body: fd });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data.url;
  }

  /* ───── 도우미 ───── */

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* 저장된 시각은 모두 한국 시간 문자열입니다 */
  var when = function (s) { return String(s || '').slice(0, 16); };
  var shortWhen = function (s) { return String(s || '').slice(5, 16); };
  var key = function (o, i) { return o + '::' + i; };
  var findOrder = function (idx) {
    return state.orders.filter(function (x) { return x.idx === idx; })[0];
  };

  /* 고른 항목 찾기 */
  function picked() {
    if (!state.pick) return null;
    var p = state.pick.split('::');
    var o = findOrder(p[0]);
    if (!o) return null;
    var it = o.items.filter(function (x) { return x.seq === Number(p[1]); })[0];
    return it ? { order: o, item: it } : null;
  }

  /* ───── 화면 뼈대 ───── */

  function shell() {
    return [
      '<div class="box" id="rlUnknown" style="display:none"></div>',

      '<div class="box">',
      '  <h3 class="rl-fold" id="rlAddHead">수동 등록 <span class="rl-arrow">▾</span></h3>',
      '  <div id="rlAdd" style="display:none"></div>',
      '</div>',

      '<div class="box">',
      '  <h3 class="rl-fold" id="rlMenuHead">룰렛 항목 관리 <span class="rl-arrow">▾</span></h3>',
      '  <div id="rlMenu" style="display:none"></div>',
      '</div>',

      '<div class="box">',
      '  <h3 class="rl-fold" id="rlBonusHead">보너스 규칙 <span class="rl-arrow">▾</span></h3>',
      '  <div id="rlBonus" style="display:none"></div>',
      '</div>',

      '<div class="box">',
      '  <h3>룰렛 숙제</h3>',
      '  <div class="rl-sum" id="rlSum"></div>',
      '  <div class="rl-bar">',
      '    <div class="rl-seg" id="rlTabs">',
      '      <button data-s="pending" class="on">대기</button>',
      '      <button data-s="done">완료</button>',
      '      <button data-s="">전체</button>',
      '    </div>',
      '    <input id="rlQ" placeholder="닉네임 · 아이디 · 보상 이름" autocomplete="off">',
      '    <button class="btn sub" id="rlSets">확률표 갱신</button>',
      '  </div>',
      '  <div id="rlList" class="rl-list"></div>',
      '  <div class="actions"><button class="btn sub" id="rlMore" style="display:none">더 보기 (' + PAGE + '건씩)</button></div>',
      '</div>',
    ].join('');
  }

  function buildDock() {
    var d = document.createElement('div');
    d.className = 'rl-dock';
    d.innerHTML = [
      '<div class="rl-dock-row">',
      '  <span class="rl-count" id="rlPicked"></span>',
      '  <input id="rlMemo" placeholder="비고 (선택)" autocomplete="off">',
      '  <input id="rlRef" placeholder="게시글 URL (선택)" autocomplete="off">',
      '</div>',
      '<div class="rl-dock-row rl-coupon-row" style="display:none">',
      '  <span class="rl-coupon-lbl">어느 숙제에 쓸까요?</span>',
      '  <select id="rlCouponTarget"></select>',
      '  <input id="rlCouponLabel" placeholder="승급 후 이름 (비우면 일반→스페셜)" autocomplete="off">',
      '  <button class="btn" data-coupon="use" type="button">사용 처리</button>',
      '  <button class="btn sub" data-coupon="undo" type="button" style="display:none">사용 취소</button>',
      '</div>',
      '<div class="rl-dock-row">',
      '  <input id="rlReply" placeholder="시청자에게 보일 답변 (선택)" autocomplete="off">',
      '  <div class="rl-acts">',
      '    <button class="btn" data-st="done">완료</button>',
      '    <button class="btn sub" data-st="pending">대기</button>',
      '    <button class="btn sub" data-st="void">제외</button>',
      '    <button class="btn sub" data-clear="1">해제</button>',
      '  </div>',
      '</div>',
      '<div class="rl-hint">비우고 저장하면 지워집니다.</div>',
      '<div class="rl-dock-row">',
      '  <div class="rl-drop" id="rlDrop" tabindex="0">',
      '    <span class="rl-drop-txt">이미지를 <b>붙여넣기(Ctrl+V)</b> 하거나 끌어다 놓으세요 · 클릭해서 고를 수도 있어요</span>',
      '  </div>',
      '  <input type="file" id="rlFile" accept="image/*" hidden>',
      '</div>',
    ].join('');

    d.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.st) apply(b.dataset.st);
      else if (b.dataset.clear) clearPick();
      else if (b.dataset.coupon === 'use') couponUse();
      else if (b.dataset.coupon === 'undo') couponUndo();
    });

    var drop = d.querySelector('#rlDrop');
    var file = d.querySelector('#rlFile');

    drop.addEventListener('click', function (e) {
      if (e.target.closest('.rl-thumb-x')) return;
      file.click();
    });
    file.addEventListener('change', function () {
      if (file.files[0]) takeImage(file.files[0]);
      file.value = '';
    });

    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('over');
      var f = e.dataTransfer.files[0];
      if (f) takeImage(f);
    });

    return d;
  }

  /* 처리 바가 떠 있을 때만 붙여넣기를 받습니다 */
  document.addEventListener('paste', function (e) {
    if (!dock || !dock.classList.contains('on')) return;
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); takeImage(f); }
        return;
      }
    }
  });

  async function takeImage(file) {
    var drop = dock.querySelector('#rlDrop');
    drop.classList.add('busy');
    drop.querySelector('.rl-drop-txt').textContent = '올리는 중…';
    try {
      state.image = await upload(file);
      renderDrop();
      say('이미지를 첨부했어요');
    } catch (e) {
      state.image = '';
      renderDrop();
      say('업로드 실패: ' + e.message);
    }
  }

  function renderDrop() {
    var drop = dock.querySelector('#rlDrop');
    drop.classList.remove('busy');
    if (state.image) {
      drop.innerHTML =
        '<img class="rl-thumb" src="' + esc(state.image) + '" alt="">' +
        '<span class="rl-drop-txt">첨부됨 — 저장하면 함께 기록돼요</span>' +
        '<button type="button" class="rl-thumb-x" title="첨부 떼기">✕</button>';
      drop.querySelector('.rl-thumb-x').addEventListener('click', function (e) {
        e.stopPropagation();
        state.image = '';
        renderDrop();
      });
    } else {
      drop.innerHTML =
        '<span class="rl-drop-txt">이미지를 <b>붙여넣기(Ctrl+V)</b> 하거나 끌어다 놓으세요 · 클릭해서 고를 수도 있어요</span>';
    }
  }

  /* ───── 미분류 안내 ───── */

  function renderUnknown() {
    var box = document.getElementById('rlUnknown');
    var un = state.menu.filter(function (m) { return m.kind === 'unknown'; });
    if (un.length === 0) { box.style.display = 'none'; return; }

    box.style.display = '';
    box.innerHTML =
      '<h3>분류가 필요한 항목 ' + un.length + '개</h3>' +
      '<p class="rl-help">방송 중에 바로 끝나는 건 <b>즉시</b>, 나중에 해줘야 하는 건 <b>숙제</b>, ' +
      '다음 룰렛 2배처럼 해줄 일이 없는 건 <b>제외</b>를 눌러주세요. 나중에 언제든 바꿀 수 있어요.</p>' +
      '<div class="rl-un">' + menuRow(un).join('') + '</div>';
    bindKindButtons(box);
  }

  /* ───── 항목 관리 (분류 수정) ───── */

  function menuRow(items, withInput) {
    return items.map(function (m) {
      var seg = ['instant', 'task', 'meta', 'coupon'].map(function (k) {
        return '<button class="rl-k' + (m.kind === k ? ' on' : '') + '" data-k="' + k +
          '" data-key="' + esc(m.label_key) + '">' + KIND[k] + '</button>';
      }).join('');

      /* 요청 받기는 숙제형에만 의미가 있습니다 */
      var ask = '';
      if (withInput && m.kind === 'task') {
        ask = '<label class="rl-ask' + (m.needs_input ? ' on' : '') + '">' +
          '<input type="checkbox" data-ask="' + esc(m.label_key) + '"' +
          (m.needs_input ? ' checked' : '') + '>요청 받기</label>' +
          '<input class="rl-askmsg" data-askmsg="' + esc(m.label_key) + '"' +
          ' placeholder="시청자에게 보일 안내 (예: 원하는 컨셉을 적어주세요)"' +
          ' value="' + esc(m.input_label || '') + '"' +
          (m.needs_input ? '' : ' style="display:none"') + '>';
      }

      return '<div class="rl-un-row">' +
        '<span class="rl-un-name">' + esc(m.label) + '</span>' +
        ask +
        '<span class="rl-kseg">' + seg + '</span></div>';
    });
  }

  /* 요청 받기 저장 */
  function bindAsk(root) {
    root.querySelectorAll('input[data-ask]').forEach(function (c) {
      c.addEventListener('change', function () {
        var key = c.dataset.ask;
        var msg = root.querySelector('input[data-askmsg="' + key + '"]');
        if (msg) msg.style.display = c.checked ? '' : 'none';
        c.closest('.rl-ask').classList.toggle('on', c.checked);
        saveAsk(key, c.checked, msg ? msg.value : '');
      });
    });
    root.querySelectorAll('input[data-askmsg]').forEach(function (i) {
      var t;
      i.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var key = i.dataset.askmsg;
          var c = root.querySelector('input[data-ask="' + key + '"]');
          saveAsk(key, c ? c.checked : false, i.value);
        }, 500);
      });
    });
  }

  async function saveAsk(label_key, on, label) {
    try {
      await api('/menu', {
        method: 'POST',
        body: { label_key: label_key, needs_input: on, input_label: label },
      });
      var m = state.menu.filter(function (x) { return x.label_key === label_key; })[0];
      if (m) { m.needs_input = on ? 1 : 0; m.input_label = label; }
    } catch (e) { say('요청 설정 실패: ' + e.message); }
  }

  /* ───── 보너스 규칙 ─────
     룰렛과 별개로 금액 조건으로 자동 생성되는 숙제.
     예) 11월에 정확히 500의 배수로 한 번에 후원 → 500개당 '11월 확정 방셀' 1개 */

  var MODE = { multiple: '정확히 배수일 때만', floor: '단위로 나눠 개수 계산', min: '이상이면 1개' };

  async function renderBonus() {
    var wrap = document.getElementById('rlBonus');
    if (!wrap) return;
    wrap.innerHTML = '<p class="rl-help">불러오는 중…</p>';

    var rules = [];
    try { rules = (await api('/bonus')).rules || []; }
    catch (e) { wrap.innerHTML = '<p class="rl-empty">불러오지 못했어요 — ' + esc(e.message) + '</p>'; return; }

    var rows = rules.map(function (r) {
      var range = (r.from_date || r.to_date)
        ? (r.from_date || '…') + ' ~ ' + (r.to_date || '…')
        : '기간 제한 없음';
      return '<div class="rl-bn-row' + (r.active ? '' : ' off') + '" data-id="' + r.id + '">' +
        '<div class="rl-bn-main">' +
        '  <b>' + esc(r.label) + '</b>' +
        '  <span class="rl-bn-cond">' + r.amount + '개 · ' + (MODE[r.mode] || r.mode) + '</span>' +
        '  <span class="rl-bn-range">' + esc(range) + '</span>' +
        '  <span class="rl-bn-stat">지급 ' + r.given + ' · 대기 ' + r.pending + '</span>' +
        '</div>' +
        '<div class="rl-bn-act">' +
        '  <button class="btn sub" data-bn="edit" type="button">수정</button>' +
        '  <button class="btn sub" data-bn="backfill" type="button" title="지금까지 들어온 후원에 소급 적용">소급 적용</button>' +
        '  <button class="btn sub" data-bn="toggle" type="button">' + (r.active ? '끄기' : '켜기') + '</button>' +
        '  <button class="rl-del" data-bn="del" type="button" title="규칙 삭제">✕</button>' +
        '</div></div>';
    }).join('');

    wrap.innerHTML =
      '<p class="rl-help">후원 금액 조건으로 자동 생성되는 숙제입니다. 동기화·수동 등록 때 자동으로 붙고, ' +
      '<b>소급 적용</b>을 누르면 이미 들어온 후원에도 붙습니다.</p>' +
      (rows || '<p class="rl-empty">아직 규칙이 없어요</p>') +
      '<div class="rl-bn-form" id="rlBnForm">' +
      '  <input type="hidden" id="bnId">' +
      '  <div class="rl-form">' +
      '    <label>숙제 이름<input id="bnLabel" placeholder="11월 확정 방셀" autocomplete="off"></label>' +
      '    <label>별풍선<input id="bnAmount" type="number" min="1" value="500"></label>' +
      '    <label>조건<select id="bnMode">' +
             Object.keys(MODE).map(function (k) { return '<option value="' + k + '">' + MODE[k] + '</option>'; }).join('') +
      '    </select></label>' +
      '  </div>' +
      '  <div class="rl-form">' +
      '    <label>시작일<input id="bnFrom" type="date"></label>' +
      '    <label>종료일<input id="bnTo" type="date"></label>' +
      '    <label class="rl-bn-chk"><input id="bnBackfill" type="checkbox" checked> 저장하면서 소급 적용</label>' +
      '  </div>' +
      '  <div class="actions">' +
      '    <span class="stat" id="bnStat"></span>' +
      '    <button class="btn sub" id="bnReset" type="button" style="display:none">새 규칙</button>' +
      '    <button class="btn" id="bnSave" type="button">규칙 추가</button>' +
      '  </div>' +
      '</div>';

    var byId = {};
    rules.forEach(function (r) { byId[r.id] = r; });

    wrap.querySelectorAll('button[data-bn]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.closest('.rl-bn-row').dataset.id);
        var r = byId[id];
        var act = b.dataset.bn;
        if (act === 'edit') fillBonusForm(r);
        else if (act === 'toggle') saveBonus(Object.assign({}, r, { active: !r.active }), false);
        else if (act === 'backfill') {
          if (confirm('"' + r.label + '" 규칙을 지금까지 들어온 후원 전체에 적용할까요?\n이미 붙은 건은 건너뜁니다.')) {
            saveBonus(r, true);
          }
        }
        else if (act === 'del') {
          if (confirm('"' + r.label + '" 규칙을 지울까요?\n아직 처리하지 않은 보너스 숙제도 함께 사라집니다. 완료한 건 남습니다.')) {
            deleteBonus(id);
          }
        }
      });
    });

    document.getElementById('bnSave').addEventListener('click', function () {
      saveBonus({
        id: Number(document.getElementById('bnId').value) || 0,
        label: document.getElementById('bnLabel').value.trim(),
        amount: Number(document.getElementById('bnAmount').value) || 0,
        mode: document.getElementById('bnMode').value,
        from_date: document.getElementById('bnFrom').value,
        to_date: document.getElementById('bnTo').value,
        active: true,
      }, document.getElementById('bnBackfill').checked);
    });
    document.getElementById('bnReset').addEventListener('click', function () { fillBonusForm(null); });
  }

  function fillBonusForm(r) {
    document.getElementById('bnId').value = r ? r.id : '';
    document.getElementById('bnLabel').value = r ? r.label : '';
    document.getElementById('bnAmount').value = r ? r.amount : 500;
    document.getElementById('bnMode').value = r ? r.mode : 'multiple';
    document.getElementById('bnFrom').value = r ? (r.from_date || '') : '';
    document.getElementById('bnTo').value = r ? (r.to_date || '') : '';
    document.getElementById('bnSave').textContent = r ? '규칙 저장' : '규칙 추가';
    document.getElementById('bnReset').style.display = r ? '' : 'none';
    if (r) document.getElementById('bnLabel').focus();
  }

  async function saveBonus(rule, backfill) {
    var stat = document.getElementById('bnStat');
    if (!rule.label || !rule.amount) { if (stat) stat.textContent = '이름과 별풍선 개수를 채워주세요'; return; }
    if (stat) stat.textContent = '저장 중…';
    try {
      var r = await api('/bonus', { method: 'POST', body: Object.assign({}, rule, { backfill: !!backfill }) });
      say(backfill ? ('숙제 ' + r.made + '개 붙였어요') : '저장했어요');
      await renderBonus();
      await refresh();
    } catch (e) { if (stat) stat.textContent = '저장 실패 — ' + e.message; }
  }

  async function deleteBonus(id) {
    try {
      await api('/bonus/delete', { method: 'POST', body: { id: id } });
      say('규칙을 지웠어요');
      await renderBonus();
      await refresh();
    } catch (e) { say('삭제 실패: ' + e.message); }
  }

  function renderMenu() {
    var wrap = document.getElementById('rlMenu');
    if (state.menu.length === 0) {
      wrap.innerHTML = '<p class="rl-empty">아직 등록된 항목이 없어요</p>';
      return;
    }
    var order = { unknown: 0, task: 1, coupon: 2, instant: 3, meta: 4 };
    var sorted = state.menu.slice().sort(function (a, b) {
      return (order[a.kind] - order[b.kind]) || String(a.label).localeCompare(String(b.label), 'ko');
    });
    wrap.innerHTML =
      '<p class="rl-help">분류를 바꾸면 앞으로 들어올 결과에 적용됩니다. ' +
      '이미 쌓인 기록까지 바꿀지는 누를 때 물어봐요.</p>' +
      menuRow(sorted, true).join('');
    bindKindButtons(wrap);
    bindAsk(wrap);
  }

  function bindKindButtons(root) {
    root.querySelectorAll('button[data-k]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = state.menu.filter(function (x) { return x.label_key === b.dataset.key; })[0];
        if (m && m.kind === b.dataset.k) return;
        classify(b.dataset.key, b.dataset.k, m ? m.kind : 'unknown');
      });
    });
  }

  async function classify(label_key, kind, prev) {
    var reapply = false;

    /* 이미 분류돼 있던 항목이면 과거 기록 처리 방침을 묻습니다 */
    if (prev && prev !== 'unknown') {
      reapply = confirm(
        label_key + ' : ' + KIND[prev] + ' → ' + KIND[kind] + '\n\n' +
        '이미 쌓인 기록도 함께 바꿀까요?\n' +
        '자동으로 처리된 것만 바꾸고, 비고나 게시글 URL을 남긴 건은 그대로 둡니다.\n\n' +
        '취소를 누르면 앞으로 들어올 결과에만 적용돼요.'
      );
    }

    try {
      var r = await api('/menu', { method: 'POST', body: { label_key: label_key, kind: kind, reapply: reapply } });
      var msg = label_key + ' → ' + KIND[kind];
      if (r.moved) msg += ' · 기록 ' + r.moved + '개 반영';
      if (r.kept) msg += ' · ' + r.kept + '개는 유지';
      say(msg);
      await refresh();
    } catch (e) { say('분류 실패: ' + e.message); }
  }

  /* ───── 수동 등록 ─────
     도전미션·대결미션 별풍선은 위플랩 룰렛이 자동으로 돌지 않아
     테스트 트리거로 처리하게 되는데, 그러면 후원관리에 기록이 남지 않습니다.
     그런 건들을 직접 넣는 창구입니다. */

  /* '2026-08-03 20:04:00' → '2026-08-03T20:04' */
  var toLocalInput = function (s) { return String(s || '').slice(0, 16).replace(' ', 'T'); };

  function nowLocal() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function renderAdd() {
    var wrap = document.getElementById('rlAdd');
    if (!wrap) return;

    var opts = state.menu
      .filter(function (m) { return m.active !== 0; })
      .map(function (m) { return '<option value="' + esc(m.label) + '">' + esc(m.label) + '</option>'; })
      .join('');

    wrap.innerHTML = [
      '<p class="rl-help">미션 별풍선처럼 위플랩에 기록이 안 남은 룰렛을 직접 넣습니다. ' +
      '나온 결과를 순서대로 담아주세요.</p>',

      '<div class="rl-form">',
      '  <label>닉네임<input id="maName" placeholder="꾸르릉꾸" autocomplete="off"></label>',
      '  <label>아이디<input id="maId" placeholder="bice0905" autocomplete="off"></label>',
      '  <label>별풍선<input id="maAmt" type="number" min="0" value="330"></label>',
      '  <label>받은 시각<input id="maAt" type="datetime-local" value="' + nowLocal() + '"></label>',
      '</div>',
      '<div class="rl-form">',
      '  <label class="wide">메모 (후원 메시지 등)<input id="maMsg" placeholder="선택" autocomplete="off"></label>',
      '</div>',

      '<div class="rl-pick">',
      '  <select id="maSel">' + (opts || '<option value="">항목 없음</option>') + '</select>',
      '  <button class="btn sub" id="maAdd" type="button">담기</button>',
      '  <input id="maFree" placeholder="목록에 없으면 직접 입력" autocomplete="off">',
      '  <button class="btn sub" id="maAddFree" type="button">직접 담기</button>',
      '</div>',
      '<div class="rl-bag" id="maBag"></div>',

      '<div class="actions">',
      '  <span class="stat" id="maStat"></span>',
      '  <button class="btn" id="maSave" type="button">등록하기</button>',
      '</div>',
    ].join('');

    renderBag();

    var add = function (v) {
      v = String(v || '').trim();
      if (!v) return;
      state.manual.push(v);
      renderBag();
    };
    document.getElementById('maAdd').addEventListener('click', function () {
      add(document.getElementById('maSel').value);
    });
    document.getElementById('maAddFree').addEventListener('click', function () {
      var el = document.getElementById('maFree');
      add(el.value); el.value = '';
    });
    document.getElementById('maFree').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add(this.value); this.value = ''; }
    });
    document.getElementById('maSave').addEventListener('click', saveManual);
  }

  function renderBag() {
    var bag = document.getElementById('maBag');
    if (!bag) return;
    if (state.manual.length === 0) {
      bag.innerHTML = '<span class="rl-bag-empty">담은 결과가 없어요</span>';
      return;
    }
    bag.innerHTML = state.manual.map(function (label, i) {
      return '<span class="rl-bagitem">' + (i + 1) + '. ' + esc(label) +
        '<button type="button" data-i="' + i + '" title="빼기">✕</button></span>';
    }).join('');
    bag.querySelectorAll('button[data-i]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.manual.splice(Number(b.dataset.i), 1);
        renderBag();
      });
    });
  }

  async function saveManual() {
    var stat = document.getElementById('maStat');
    if (state.manual.length === 0) { stat.textContent = '룰렛 결과를 먼저 담아주세요'; return; }

    var name = document.getElementById('maName').value.trim();
    var id = document.getElementById('maId').value.trim();
    if (!name && !id) { stat.textContent = '닉네임이나 아이디 중 하나는 필요해요'; return; }

    stat.textContent = '등록 중…';
    try {
      var r = await api('/manual', {
        method: 'POST',
        body: {
          donor_name: name,
          donor_id: id,
          amount: Number(document.getElementById('maAmt').value) || 0,
          donated_at: document.getElementById('maAt').value,
          msg: document.getElementById('maMsg').value.trim(),
          labels: state.manual,
        },
      });
      var msg = '결과 ' + r.items + '개 등록 · 숙제 ' + r.tasks + '개';
      if (r.unknown && r.unknown.length) msg += ' · 미분류 ' + r.unknown.length + '개';
      say(msg);
      state.manual = [];
      document.getElementById('maMsg').value = '';
      stat.textContent = '';
      await refresh();
      renderBag();
    } catch (e) {
      stat.textContent = '등록 실패 — ' + e.message;
    }
  }

  /* ───── 숙제 목록 ───── */

  function renderList() {
    var wrap = document.getElementById('rlList');

    if (state.orders.length === 0) {
      wrap.innerHTML = '<p class="rl-empty">' +
        (state.status === 'pending' ? '남은 숙제가 없어요 🎉' : '해당하는 내역이 없어요') + '</p>';
      document.getElementById('rlMore').style.display = 'none';
      placeDock();
      return;
    }

    wrap.innerHTML = state.orders.map(function (o) {
      var prog = o.task_total
        ? '<span class="rl-prog' + (o.task_done === o.task_total ? ' full' : '') + '">완료 ' +
          o.task_done + '/' + o.task_total + '</span>'
        : '';

      var items = o.items.map(function (it) {
        var k = key(o.idx, it.seq);
        var extra = [];
        if (it.resolved_label) extra.push('→ <b>' + esc(it.resolved_label) + '</b>');
        if (it.coupon_used) extra.push('<span class="rl-cp">🎟 교환권 승급</span>');
        if (it.kind === 'coupon' && it.status === 'used' && it.used_for) {
          var tgt = findItemByKey(it.used_for);
          extra.push('<span class="rl-cp">🎟 ' + esc(tgt ? tgt.label : '사용됨') + ' 에 사용</span>');
        }
        if (it.memo) extra.push(esc(it.memo));

        /* 시청자가 남긴 요청 */
        var req = '';
        if (it.request || it.request_image || it.request_email) {
          req = '<div class="rl-req"><b>요청</b> ' + esc(it.request || '') +
            (it.request_email
              ? '<span class="rl-mail">✉ ' + esc(it.request_email) + '</span>' : '') +
            (it.request_image
              ? '<a class="rl-shot" href="' + esc(it.request_image) + '" target="_blank">' +
                '<img src="' + esc(it.request_image) + '" alt=""></a>' : '') +
            '</div>';
        } else if (needsInput(it.label)) {
          req = '<div class="rl-req wait">요청 기다리는 중</div>';
        }
        if (it.reply) {
          req += '<div class="rl-req reply"><b>답변</b> ' + esc(it.reply) + '</div>';
        }

        var right =
          (it.image_url ? '<a class="rl-shot" href="' + esc(it.image_url) + '" target="_blank">' +
            '<img src="' + esc(it.image_url) + '" alt=""></a>' : '') +
          (it.done_ref ? '<a class="rl-ref" href="' + esc(it.done_ref) + '" target="_blank">게시글</a>' : '') +
          (it.done_at ? '<span class="rl-done-at">' + shortWhen(it.done_at) + '</span>' : '') +
          '<span class="rl-st rl-' + it.status + '">' + (STATUS[it.status] || it.status) + '</span>';

        return '<label class="rl-item' + (state.pick === k ? ' sel' : '') + '">' +
          '<input type="radio" name="rlPick" data-k="' + k + '" data-order="' + esc(o.idx) + '"' +
          (state.pick === k ? ' checked' : '') + '>' +
          '<span class="rl-label">' + esc(it.label) + '</span>' +
          (String(it.label_key || '').indexOf('bonus:') === 0
            ? '<span class="rl-bonus">보너스</span>'
            : '<span class="rl-pct">' + it.percent + '%</span>') +
          (extra.length ? '<span class="rl-extra">' + extra.join(' · ') + '</span>' : '') +
          '<span class="rl-right">' + right + '</span>' +
          '</label>' + req;
      }).join('');

      return '<div class="rl-order" data-order="' + esc(o.idx) + '">' +
        '<div class="rl-head">' +
        '<b>' + esc(o.donor_name) + '</b><span class="rl-id">' + esc(o.donor_id) + '</span>' +
        (o.donor_id
          ? '<a class="rl-home" href="' + esc(station(o.donor_id)) + '" target="_blank" rel="noopener"' +
            ' title="' + esc(o.donor_name) + ' 방송국 열기">\uD83C\uDFE0</a>'
          : '') +
        '<span class="rl-amt">' + o.amount + '개</span>' +
        (o.donor_id
          ? '<span class="rl-codebox">' +
            '<button class="rl-code" data-code="' + esc(o.donor_id) + '"' +
              (o.code ? ' data-has="' + esc(o.code) + '"' : '') +
              ' title="' + (o.code ? '눌러서 코드 보기·복사' : '코드 발급하기') + '">' +
              '🔑 ' + (o.code ? '<i>' + '•'.repeat(Math.min(o.code.length, 10)) + '</i>' : '발급') +
            '</button>' +
            '<button class="rl-codeed" data-codeed="' + esc(o.donor_id) + '"' +
              ' data-name="' + esc(o.donor_name || o.donor_id) + '"' +
              (o.code ? ' data-cur="' + esc(o.code) + '"' : '') +
              ' title="코드 직접 정하기">✎</button>' +
            '</span>'
          : '') +
        (String(o.idx).charAt(0) === 'M'
          ? '<span class="rl-manual">수동</span>' +
            '<button class="rl-ed" data-edit="' + esc(o.idx) + '" title="후원자·개수·시각 고치기">✎</button>' +
            '<button class="rl-del" data-del="' + esc(o.idx) + '" title="이 수동 등록 지우기">✕</button>'
          : '') +
        '<span class="rl-time">' + when(o.donated_at) + '</span>' +
        (o.msg ? '<span class="rl-msg">' + esc(o.msg) + '</span>' : '') +
        prog +
        '</div>' +
        (String(o.idx).charAt(0) === 'M' ? editForm(o) : '') +
        items + '</div>';
    }).join('');

    /* 같은 항목을 다시 누르면 선택이 풀립니다 */
    wrap.querySelectorAll('input[type=radio]').forEach(function (r) {
      r.addEventListener('click', function () {
        if (state.pick === r.dataset.k) {
          state.pick = null;
          r.checked = false;
          resetInputs();
          renderList();
        } else {
          state.pick = r.dataset.k;
          renderList();
          loadPick();          /* 고른 항목의 기존 값을 불러옵니다 */
        }
      });
    });

    wrap.querySelectorAll('button[data-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('수동으로 등록한 이 건을 지울까요?\n처리 기록도 함께 사라집니다.')) return;
        try {
          await api('/manual/delete', { method: 'POST', body: { idx: b.dataset.del } });
          say('지웠어요');
          await refresh();
        } catch (e) { say('삭제 실패: ' + e.message); }
      });
    });

    bindEdit(wrap);

    /* 코드는 눌러야 보입니다. 어깨너머로 새는 걸 막으려고 가려둡니다. */
    wrap.querySelectorAll('button[data-code]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var code = b.dataset.has;

        if (!code) {
          try {
            var r = await api('/code', { method: 'POST', body: { donor_id: b.dataset.code } });
            code = r.code;
            b.dataset.has = code;
          } catch (e) { say('발급 실패: ' + e.message); return; }
        }

        var dots = '•'.repeat(Math.min(code.length, 10));

        /* 이미 보이는 상태면 다시 가립니다 */
        if (b.classList.contains('open')) {
          b.classList.remove('open');
          b.querySelector('i').textContent = dots;
          b.title = '눌러서 코드 보기·복사';
          return;
        }

        b.classList.add('open');
        b.querySelector('i').textContent = code;
        b.title = '눌러서 다시 가리기';
        try { await navigator.clipboard.writeText(code); say('코드 ' + code + ' 복사했어요'); }
        catch (e) { say('코드: ' + code); }
      });
    });

    wrap.querySelectorAll('button[data-codeed]').forEach(function (b) {
      b.addEventListener('click', function () {
        openCodeModal(b.dataset.codeed, b.dataset.name, b.dataset.cur || '');
      });
    });

    document.getElementById('rlMore').style.display = state.hasMore ? '' : 'none';
    placeDock();
  }

  /* 이 항목이 요청 받기 대상인지 */
  function needsInput(label) {
    var k = normKeyish(label);
    var m = state.menu.filter(function (x) { return x.label_key === k; })[0];
    return !!(m && m.needs_input);
  }
  var normKeyish = function (s) {
    return String(s || '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '')
      .replace(/\s+/g, ' ').trim();
  };

  /* ───── 코드 수정 모달 ───── */

  var codeModal = null;

  function buildCodeModal() {
    var m = document.createElement('div');
    m.className = 'rl-modal';
    m.innerHTML = [
      '<div class="rl-modal-in">',
      '  <h4>요청 코드</h4>',
      '  <p class="rl-modal-who"></p>',
      '  <input class="rl-modal-inp" maxlength="16" autocomplete="off" spellcheck="false"',
      '         placeholder="비워두면 자동으로 만들어요">',
      '  <p class="rl-modal-hint">영문과 숫자로 4~16자. 시청자에게 알려줄 값이라 ',
      '     기억하기 쉬운 걸로 정해도 됩니다.</p>',
      '  <p class="rl-modal-err"></p>',
      '  <div class="rl-modal-act">',
      '    <button class="btn sub" type="button" data-close="1">취소</button>',
      '    <button class="btn" type="button" data-ok="1">저장</button>',
      '  </div>',
      '</div>',
    ].join('');

    m.addEventListener('click', function (e) {
      if (e.target === m || e.target.closest('[data-close]')) closeCodeModal();
      else if (e.target.closest('[data-ok]')) saveCodeModal();
    });
    m.querySelector('.rl-modal-inp').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveCodeModal();
      if (e.key === 'Escape') closeCodeModal();
    });

    document.body.appendChild(m);
    return m;
  }

  function openCodeModal(donorId, name, cur) {
    if (!codeModal) codeModal = buildCodeModal();
    codeModal.dataset.donor = donorId;
    codeModal.querySelector('.rl-modal-who').textContent = name;
    codeModal.querySelector('.rl-modal-err').textContent = '';
    var inp = codeModal.querySelector('.rl-modal-inp');
    inp.value = cur;
    codeModal.classList.add('on');
    inp.focus();
    inp.select();
  }

  function closeCodeModal() {
    if (codeModal) codeModal.classList.remove('on');
  }

  async function saveCodeModal() {
    var inp = codeModal.querySelector('.rl-modal-inp');
    var err = codeModal.querySelector('.rl-modal-err');
    var want = inp.value.trim().toUpperCase();

    if (want && !/^[A-Z0-9]{4,16}$/.test(want)) {
      err.textContent = '영문과 숫자로 4~16자여야 해요';
      return;
    }

    err.textContent = '';
    try {
      var r = await api('/code', {
        method: 'POST',
        body: { donor_id: codeModal.dataset.donor, code: want, force: true },
      });
      closeCodeModal();
      try { await navigator.clipboard.writeText(r.code); } catch (e) { }
      say('코드 ' + r.code + ' · 복사됐어요');
      await refresh();
    } catch (e) {
      err.textContent = e.message === 'duplicate'
        ? '이미 다른 분이 쓰고 있는 코드예요'
        : '저장하지 못했어요 — ' + e.message;
    }
  }

  /* ───── 수동 건 고치기 ───── */

  function editForm(o) {
    return '<div class="rl-edit" data-form="' + esc(o.idx) + '">' +
      '<div class="rl-form">' +
      '  <label>닉네임<input data-f="donor_name" value="' + esc(o.donor_name || '') + '"></label>' +
      '  <label>아이디<input data-f="donor_id" value="' + esc(o.donor_id || '') + '"></label>' +
      '  <label>별풍선<input data-f="amount" type="number" min="0" value="' + (o.amount || 0) + '"></label>' +
      '  <label>받은 시각<input data-f="donated_at" type="datetime-local" value="' +
             esc(toLocalInput(o.donated_at)) + '"></label>' +
      '</div>' +
      '<div class="rl-edit-act">' +
      '  <button class="btn sub" data-cancel="1" type="button">취소</button>' +
      '  <button class="btn" data-save="' + esc(o.idx) + '" type="button">저장</button>' +
      '</div></div>';
  }

  function bindEdit(wrap) {
    wrap.querySelectorAll('button[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var form = wrap.querySelector('.rl-edit[data-form="' + b.dataset.edit + '"]');
        if (form) form.classList.toggle('on');
      });
    });

    wrap.querySelectorAll('.rl-edit').forEach(function (form) {
      form.querySelector('button[data-cancel]').addEventListener('click', function () {
        form.classList.remove('on');
      });
      form.querySelector('button[data-save]').addEventListener('click', async function (e) {
        var btn = e.currentTarget;
        var body = { idx: btn.dataset.save };
        form.querySelectorAll('input[data-f]').forEach(function (inp) {
          body[inp.dataset.f] = inp.value;
        });
        btn.disabled = true;
        try {
          await api('/manual/update', { method: 'POST', body: body });
          say('고쳤어요');
          await refresh();
        } catch (err) {
          say('저장 실패: ' + err.message);
          btn.disabled = false;
        }
      });
    });
  }

  /* ───── 처리 바 ───── */

  function placeDock() {
    var p = picked();

    if (!p) {
      dock.classList.remove('on');
      if (dock.parentNode) dock.parentNode.removeChild(dock);
      return;
    }

    var target = document.querySelector('.rl-order[data-order="' + p.order.idx + '"]');
    if (!target) return;

    dock.querySelector('#rlPicked').textContent = p.item.label;
    dock.classList.add('on');
    target.insertAdjacentElement('afterend', dock);
    setCouponMode(p);
  }

  /* 쿠폰을 골랐으면 상태 버튼 대신 사용 처리 줄을 보여줍니다 */
  function setCouponMode(p) {
    var isCoupon = p.item.kind === 'coupon';
    var row = dock.querySelector('.rl-coupon-row');
    var acts = dock.querySelector('.rl-acts');
    row.style.display = isCoupon ? '' : 'none';
    acts.querySelectorAll('button[data-st]').forEach(function (b) {
      b.style.display = isCoupon ? 'none' : '';
    });
    if (!isCoupon) return;

    var used = p.item.status === 'used';
    dock.querySelector('[data-coupon="use"]').style.display = used ? 'none' : '';
    dock.querySelector('[data-coupon="undo"]').style.display = used ? '' : 'none';
    var sel = dock.querySelector('#rlCouponTarget');
    var inp = dock.querySelector('#rlCouponLabel');
    sel.style.display = inp.style.display = used ? 'none' : '';
    dock.querySelector('.rl-coupon-lbl').textContent = used ? '이미 사용한 쿠폰입니다' : '어느 숙제에 쓸까요?';
    if (used) return;

    /* 같은 후원자의 대기 숙제만 후보로 */
    var donor = p.order.donor_id;
    var opts = [];
    state.orders.forEach(function (o) {
      if (o.donor_id !== donor) return;
      o.items.forEach(function (it) {
        if (it.kind === 'coupon' || it.status !== 'pending') return;
        opts.push('<option value="' + esc(key(o.idx, it.seq)) + '">' +
          esc(it.resolved_label || it.label) + ' · ' + when(o.donated_at).slice(5) + '</option>');
      });
    });
    sel.innerHTML = opts.length ? opts.join('') : '<option value="">대기 중인 숙제가 없어요</option>';
    inp.value = '';
  }

  function findItemByKey(k) {
    var p = String(k || '').split('::');
    var o = findOrder(p[0]);
    return o && o.items.filter(function (x) { return x.seq === Number(p[1]); })[0];
  }

  async function couponUse() {
    var p = picked();
    if (!p) return;
    var target = dock.querySelector('#rlCouponTarget').value;
    if (!target) { say('쓸 숙제를 골라주세요'); return; }
    var t = target.split('::');
    try {
      var r = await api('/coupon/use', {
        method: 'POST',
        body: {
          order_idx: p.order.idx, seq: p.item.seq,
          target_order_idx: t[0], target_seq: Number(t[1]),
          new_label: dock.querySelector('#rlCouponLabel').value.trim(),
        },
      });
      say('🎟 ' + r.new_label + ' 로 승급했어요');
      state.pick = null;
      await refresh();
    } catch (e) { say('사용 처리 실패: ' + e.message); }
  }

  async function couponUndo() {
    var p = picked();
    if (!p) return;
    if (!confirm('쿠폰 사용을 취소할까요?\n승급 표시도 되돌아갑니다.')) return;
    try {
      await api('/coupon/undo', { method: 'POST', body: { order_idx: p.order.idx, seq: p.item.seq } });
      say('쿠폰을 되돌렸어요');
      state.pick = null;
      await refresh();
    } catch (e) { say('취소 실패: ' + e.message); }
  }

  /* 고른 항목의 기존 값을 처리 바에 채웁니다 */
  function loadPick() {
    var p = picked();
    if (!p) return;
    dock.querySelector('#rlMemo').value = p.item.memo || '';
    dock.querySelector('#rlRef').value = p.item.done_ref || '';
    dock.querySelector('#rlReply').value = p.item.reply || '';
    state.image = p.item.image_url || '';
    renderDrop();
  }

  function resetInputs() {
    state.image = '';
    dock.querySelector('#rlMemo').value = '';
    dock.querySelector('#rlRef').value = '';
    dock.querySelector('#rlReply').value = '';
    renderDrop();
  }

  function clearPick() {
    state.pick = null;
    resetInputs();
    renderList();
  }

  function renderSum(s) {
    document.getElementById('rlSum').innerHTML =
      '<span class="rl-chip wait">대기 <b>' + s.pending + '</b></span>' +
      '<span class="rl-chip done">완료 <b>' + s.done + '</b></span>' +
      (s.unclassified ? '<span class="rl-chip warn">미분류 <b>' + s.unclassified + '</b></span>' : '');
  }

  /* ───── 동작 ───── */

  async function refresh(keepOffset) {
    if (!keepOffset) { state.offset = 0; state.orders = []; state.pick = null; state.image = ''; }
    var qs = '?scope=task&order=asc&limit=' + PAGE + '&offset=' + state.offset +
      (state.status ? '&status=' + state.status : '') +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '');

    try {
      var res = await Promise.all([api('/stats'), api('/menu'), api('/list' + qs)]);
      renderSum(res[0]);
      state.menu = res[1].menu || [];
      renderUnknown();
      if (state.menuOpen) renderMenu();

      state.orders = state.offset === 0 ? res[2].orders : state.orders.concat(res[2].orders);
      state.hasMore = res[2].hasMore;
      renderList();
    } catch (e) {
      document.getElementById('rlList').innerHTML =
        '<p class="rl-empty">불러오지 못했어요 — ' + esc(e.message) + '</p>';
    }
  }

  async function apply(status) {
    var p = picked();
    if (!p) return;

    var memo = dock.querySelector('#rlMemo').value.trim();
    var ref = dock.querySelector('#rlRef').value.trim();
    var reply = dock.querySelector('#rlReply').value.trim();

    try {
      await api('/items/status', {
        method: 'POST',
        body: {
          targets: [{ order_idx: p.order.idx, seq: p.item.seq }],
          status: status,
          /* 화면에 보이는 그대로 저장합니다 — 빈 칸은 지우기 */
          memo: memo,
          done_ref: ref,
          image_url: state.image,
          reply: reply,
        },
      });
      say(p.item.label + ' → ' + STATUS[status]);
      state.pick = null;
      resetInputs();
      await refresh();
    } catch (e) { say('처리 실패: ' + e.message); }
  }

  /* ───── 초기화 ───── */

  var ready = false;
  function ensure() {
    if (ready) { refresh(); return; }
    var panel = document.getElementById('p-roulette');
    if (!panel) return;
    panel.innerHTML = shell();
    dock = buildDock();
    ready = true;

    document.getElementById('rlAddHead').addEventListener('click', function () {
      var box = document.getElementById('rlAdd');
      var open = box.style.display === 'none';
      box.style.display = open ? '' : 'none';
      this.querySelector('.rl-arrow').textContent = open ? '▴' : '▾';
      if (open) renderAdd();
    });

    document.getElementById('rlBonusHead').addEventListener('click', function () {
      var box = document.getElementById('rlBonus');
      var open = box.style.display === 'none';
      box.style.display = open ? '' : 'none';
      this.querySelector('.rl-arrow').textContent = open ? '▴' : '▾';
      if (open) renderBonus();
    });

    document.getElementById('rlMenuHead').addEventListener('click', function () {
      state.menuOpen = !state.menuOpen;
      document.getElementById('rlMenu').style.display = state.menuOpen ? '' : 'none';
      this.querySelector('.rl-arrow').textContent = state.menuOpen ? '▴' : '▾';
      if (state.menuOpen) renderMenu();
    });

    document.getElementById('rlTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-s]');
      if (!b) return;
      state.status = b.dataset.s;
      this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      refresh();
    });

    var qEl = document.getElementById('rlQ');
    var timer;
    qEl.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = qEl.value.trim(); refresh(); }, 300);
    });

    document.getElementById('rlMore').addEventListener('click', function () {
      state.offset += PAGE;
      refresh(true);
    });

    document.getElementById('rlSets').addEventListener('click', async function () {
      say('확률표 확인 중…');
      try {
        var r = await api('/sets/sync?force=1', { method: 'POST' });
        say(r.changed ? '새 룰렛 세트를 받았어요' : '바뀐 내용이 없어요');
        await refresh();
      } catch (e) { say('갱신 실패: ' + e.message); }
    });

    refresh();
  }

  /* 탭을 처음 열 때 불러옵니다 */
  var origTab = window.tab;
  window.tab = function (n) {
    if (typeof origTab === 'function') origTab(n);
    if (n === 'roulette') ensure();
  };

  /* ───── 스타일 ───── */

  var css = document.createElement('style');
  css.textContent = [
    '.rl-sum{display:flex;gap:8px;margin-bottom:14px}',
    '.rl-chip{padding:5px 11px;border-radius:999px;font-size:13px;background:#f2f4f6;color:#4e5968}',
    '.rl-chip b{margin-left:3px}',
    '.rl-chip.wait{background:#e8f3ff;color:#1b64da}',
    '.rl-chip.warn{background:#fff3e0;color:#c56b00}',
    '.rl-fold{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px}',
    '.rl-bn-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;',
    'border:1px solid #e5e8eb;border-radius:10px;margin-bottom:8px;background:#fff}',
    '.rl-bn-row.off{opacity:.55}',
    '.rl-bn-main{flex:1;min-width:220px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:#6b7684}',
    '.rl-bn-main b{color:#333d4b;font-size:14px}',
    '.rl-bn-cond{color:#1b64da}',
    '.rl-bn-range{color:#8b95a1}',
    '.rl-bn-stat{font-size:12px;color:#8b95a1}',
    '.rl-bn-act{display:flex;gap:5px;align-items:center}',
    '.rl-bn-act .btn{padding:5px 11px;font-size:12px}',
    '.rl-bn-form{margin-top:12px;padding-top:12px;border-top:1px solid #f2f4f6}',
    '.rl-bn-form select{padding:8px 11px;border:1px solid #e5e8eb;border-radius:8px;font:inherit;font-size:13px;color:#333d4b}',
    '.rl-bn-chk{flex-direction:row !important;align-items:center;gap:6px !important;font-size:13px !important;color:#4e5968 !important;align-self:flex-end;padding-bottom:9px}',
    '.rl-bonus{font-size:11px;font-weight:700;color:#0f8b4c;background:#e8f7ee;padding:1px 7px;border-radius:5px}',
    '.rl-arrow{font-size:12px;color:#b0b8c1}',
    '.rl-bar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}',
    '.rl-bar input{flex:1;min-width:150px;padding:8px 11px;border:1px solid #e5e8eb;border-radius:8px;font:inherit;font-size:13px}',
    '.rl-seg{display:flex;border:1px solid #e5e8eb;border-radius:8px;overflow:hidden}',
    '.rl-seg button{padding:8px 14px;border:0;background:#fff;font:inherit;font-size:13px;color:#8b95a1;cursor:pointer}',
    '.rl-seg button.on{background:#3182f6;color:#fff;font-weight:600}',
    '.rl-order{border:1px solid #e5e8eb;border-radius:12px;padding:12px 14px;margin-bottom:10px}',
    '.rl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:#6b7684;margin-bottom:8px}',
    '.rl-head b{color:#333d4b;font-size:14px}',
    '.rl-id{color:#b0b8c1}',
    '.rl-home{display:inline-flex;align-items:center;justify-content:center;',
    'width:24px;height:24px;border-radius:7px;font-size:13px;line-height:1;text-decoration:none;',
    'background:#f2f4f6;transition:background .15s,transform .15s}',
    '.rl-home:hover{background:#e8f3ff;transform:translateY(-1px)}',
    '.rl-amt{color:#1b64da;font-weight:600}',
    '.rl-msg{color:#8b95a1;font-style:italic}',
    '.rl-prog{margin-left:auto;font-size:12px;padding:2px 9px;border-radius:999px;background:#f2f4f6;color:#6b7684}',
    '.rl-prog.full{background:#e8f7ee;color:#0f8b4c}',
    '.rl-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:8px;font-size:13px;cursor:pointer}',
    '.rl-item:hover{background:#f8f9fa}',
    '.rl-item.sel{background:#e8f3ff}',
    '.rl-label{font-weight:600;color:#333d4b}',
    '.rl-pct{color:#b0b8c1;font-size:12px}',
    '.rl-extra{color:#6b7684;font-size:12px}',
    '.rl-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex:0 0 auto}',
    '.rl-done-at{font-size:12px;color:#8b95a1;white-space:nowrap}',
    '.rl-st{font-size:12px;padding:2px 8px;border-radius:6px;background:#f2f4f6;color:#8b95a1;white-space:nowrap}',
    '.rl-st.rl-pending{background:#fff3e0;color:#c56b00}',
    '.rl-st.rl-done{background:#e8f7ee;color:#0f8b4c}',
    '.rl-st.rl-held{background:#f3edff;color:#6b3fd1}',
    '.rl-st.rl-used{background:#f2f4f6;color:#8b95a1}',
    '.rl-cp{color:#6b3fd1;font-weight:600}',
    '.rl-coupon-lbl{font-size:13px;color:#6b3fd1;font-weight:600;white-space:nowrap}',
    '.rl-dock #rlCouponTarget{flex:2;min-width:200px;padding:8px 11px;border:1px solid #d1d6db;',
    'border-radius:8px;font:inherit;font-size:13px;background:#fff}',
    '.rl-dock #rlCouponLabel{flex:1;min-width:170px}',
    '.rl-ref{font-size:12px;color:#3182f6;white-space:nowrap}',
    '.rl-shot img{width:26px;height:26px;object-fit:cover;border-radius:6px;border:1px solid #e5e8eb;display:block}',
    '.rl-empty{text-align:center;color:#8b95a1;padding:36px 0;font-size:14px}',
    '.rl-help{font-size:13px;color:#6b7684;margin:-4px 0 12px}',
    '.rl-form{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}',
    '.rl-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#8b95a1;flex:1;min-width:130px}',
    '.rl-form label.wide{flex:1 1 100%}',
    '.rl-form input{padding:8px 11px;border:1px solid #e5e8eb;border-radius:8px;',
    'font:inherit;font-size:13px;color:#333d4b}',
    '.rl-pick{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 10px;',
    'padding-top:13px;border-top:1px solid #f2f4f6}',
    '.rl-pick select,.rl-pick input{padding:8px 11px;border:1px solid #e5e8eb;border-radius:8px;',
    'font:inherit;font-size:13px;color:#333d4b;min-width:140px}',
    '.rl-pick input{flex:1}',
    '.rl-bag{display:flex;flex-wrap:wrap;gap:6px;min-height:34px;padding:8px;border-radius:10px;',
    'background:#f8f9fa}',
    '.rl-bag-empty{font-size:12px;color:#b0b8c1;padding:3px 4px}',
    '.rl-bagitem{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;',
    'color:#1b64da;background:#e8f3ff;border-radius:8px;padding:5px 6px 5px 10px}',
    '.rl-bagitem button{border:0;background:none;color:#8b95a1;font-size:12px;cursor:pointer;padding:0 3px}',
    '.rl-bagitem button:hover{color:#d64545}',
    '.rl-manual{font-size:12px;font-weight:700;color:#0f8b4c;background:#e8f7ee;',
    'padding:2px 8px;border-radius:6px}',
    '.rl-del{border:0;background:none;color:#b0b8c1;font-size:12px;cursor:pointer;padding:2px 4px}',
    '.rl-del:hover{color:#d64545}',
    '.rl-ed{border:0;background:none;color:#b0b8c1;font-size:13px;cursor:pointer;padding:2px 4px}',
    '.rl-codebox{display:inline-flex;align-items:center;gap:1px;flex:0 0 auto}',
    '.rl-code i{font-style:normal;letter-spacing:1.5px}',
    '.rl-code.open i{letter-spacing:.5px;color:#1b64da}',
    '.rl-codeed{border:0;background:none;color:#b0b8c1;font-size:12px;cursor:pointer;padding:2px 4px}',
    '.rl-codeed:hover{color:#3182f6}',
    '.rl-modal{position:fixed;inset:0;z-index:9000;display:none;place-items:center;',
    'background:rgba(0,0,0,.35);padding:20px}',
    '.rl-modal.on{display:grid}',
    '.rl-modal-in{width:100%;max-width:340px;background:#fff;border-radius:16px;padding:22px 24px;',
    'box-shadow:0 12px 40px rgba(0,0,0,.18)}',
    '.rl-modal-in h4{font-size:16px;color:#333d4b;margin:0 0 3px}',
    '.rl-modal-who{font-size:13px;color:#8b95a1;margin:0 0 14px}',
    '.rl-modal-inp{width:100%;box-sizing:border-box;padding:11px 14px;border:1px solid #e5e8eb;',
    'border-radius:9px;font:inherit;font-size:15px;letter-spacing:1.5px;text-transform:uppercase;',
    'color:#333d4b}',
    '.rl-modal-inp:focus{outline:2px solid #3182f6;outline-offset:-1px;border-color:transparent}',
    '.rl-modal-hint{font-size:12px;color:#8b95a1;line-height:1.55;margin:8px 0 0}',
    '.rl-modal-err{font-size:13px;color:#d64545;margin:8px 0 0;min-height:1px}',
    '.rl-modal-act{display:flex;gap:7px;justify-content:flex-end;margin-top:16px}',
    '.rl-code{border:1px solid #e5e8eb;background:#fff;color:#4e5968;font:inherit;font-size:11px;',
    'font-weight:600;letter-spacing:.5px;cursor:pointer;padding:3px 9px;border-radius:7px}',
    '.rl-code:hover{background:#e8f3ff;border-color:#3182f6;color:#1b64da}',
    '.rl-ask{display:flex;align-items:center;gap:4px;font-size:12px;color:#8b95a1;',
    'cursor:pointer;white-space:nowrap;flex:0 0 auto}',
    '.rl-ask.on{color:#1b64da;font-weight:600}',
    '.rl-askmsg{flex:1 1 200px;min-width:0;padding:5px 10px;border:1px solid #e5e8eb;',
    'border-radius:7px;font:inherit;font-size:12px;color:#333d4b}',
    '.rl-req{margin:-2px 0 6px 31px;padding:7px 11px;border-radius:8px;background:#f8f9fa;',
    'font-size:13px;color:#333d4b;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
    '.rl-req b{color:#1b64da;font-size:12px;margin-right:5px}',
    '.rl-req.wait{color:#b0b8c1;font-style:italic}',
    '.rl-req.reply{background:#eef6ff}',
    '.rl-req.reply b{color:#0f8b4c}',
    '.rl-req .rl-mail{display:inline-block;margin-left:8px;font-size:12px;color:#6b7684}',
    '.rl-req .rl-shot{display:inline-block;margin-left:8px;vertical-align:middle}',
    '.rl-ed:hover{color:#3182f6}',
    '.rl-edit{display:none;margin:4px 0 10px;padding:12px 13px;border-radius:11px;',
    'background:#f8f9fa;border:1px solid #e5e8eb}',
    '.rl-edit.on{display:block}',
    '.rl-edit .rl-form{margin-bottom:0}',
    '.rl-edit-act{display:flex;gap:6px;justify-content:flex-end;margin-top:10px}',
    '.rl-edit-act .btn{padding:6px 14px;font-size:13px}',
    '.rl-un-row{display:flex;align-items:center;gap:8px;padding:8px 10px;margin:0 -10px;border-radius:8px;border-bottom:1px solid #f2f4f6;transition:background .12s}',
    '.rl-un-row:last-child{border-bottom:0}',
    '.rl-un-row:hover{background:#f8f9fa}',
    '.rl-un-row:hover .rl-kseg{border-color:#d1d6db}',
    '.rl-un-name{flex:1;font-weight:600;font-size:14px}',
    '.rl-kseg{display:flex;border:1px solid #e5e8eb;border-radius:8px;overflow:hidden;flex:0 0 auto;transition:border-color .12s}',
    '.rl-k{padding:6px 13px;border:0;background:#fff;font:inherit;font-size:12px;color:#8b95a1;cursor:pointer}',
    '.rl-k+.rl-k{border-left:1px solid #e5e8eb}',
    '.rl-k:hover{background:#f2f4f6}',
    '.rl-k.on{background:#3182f6;color:#fff;font-weight:600}',
    /* 처리 바 — 고른 항목이 있는 카드 바로 아래에 붙습니다 */
    '.rl-dock{display:none;flex-direction:column;gap:8px;',
    'margin:-4px 0 14px;padding:11px 13px;border-radius:12px;',
    'background:#f8fbff;border:1px solid #c9deff}',
    '.rl-dock.on{display:flex}',
    '.rl-dock-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.rl-hint{font-size:12px;color:#6b7684;margin:-4px 0 0 2px}',
    '.rl-count{font-size:13px;color:#1b64da;font-weight:700;white-space:nowrap}',
    '.rl-dock input{padding:8px 11px;border:1px solid #d1d6db;border-radius:8px;font:inherit;font-size:13px;background:#fff}',
    '.rl-dock #rlMemo{flex:3;min-width:220px}',
    '.rl-dock #rlReply{flex:1;min-width:240px}',
    '.rl-dock #rlRef{flex:2;min-width:160px}',
    '.rl-acts{display:flex;gap:6px;margin-left:auto}',
    '.rl-drop{flex:1;display:flex;align-items:center;gap:9px;padding:9px 12px;',
    'border:1px dashed #b9d3ff;border-radius:9px;background:#fff;cursor:pointer;transition:background .12s,border-color .12s}',
    '.rl-drop:hover,.rl-drop.over{background:#eef6ff;border-color:#3182f6}',
    '.rl-drop.busy{opacity:.6}',
    '.rl-drop-txt{font-size:12px;color:#6b7684}',
    '.rl-thumb{width:34px;height:34px;object-fit:cover;border-radius:7px;border:1px solid #e5e8eb}',
    '.rl-thumb-x{margin-left:auto;border:0;background:none;color:#8b95a1;font-size:13px;cursor:pointer;padding:2px 4px}',
    '.rl-thumb-x:hover{color:#d64545}',
  ].join('');
  document.head.appendChild(css);
})();