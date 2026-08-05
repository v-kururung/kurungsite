/* ═══════════════════════════════════════════════════════════
   룰렛 숙제 관리 — admin.html 의 🎯 룰렛 숙제 탭

   admin.html 에는 이미 아래 세 가지가 들어가 있습니다.
     · 탭 버튼   <button data-t="roulette" onclick="tab('roulette')">
     · 패널 자리 <div class="panel" id="p-roulette"></div>
     · 스크립트  <script src="admin-roulette.js"></script>
   ═══════════════════════════════════════════════════════════ */

(function () {
  var BASE = (typeof API !== 'undefined' ? API : '/api') + '/roulette';
  var token = function () {
    if (typeof DB !== 'undefined' && DB.token) return DB.token();
    return localStorage.getItem('adminToken') || '';
  };
  var say = function (m) { if (typeof toast === 'function') toast(m); else console.log(m); };

  var KIND = { instant: '즉시', task: '숙제', meta: '제외', unknown: '미분류' };
  var STATUS = { pending: '대기', scheduled: '예정', done: '완료', void: '제외' };

  var state = {
    status: 'pending', q: '', offset: 0,
    orders: [], hasMore: false, sel: {}, menu: [], menuOpen: false,
    anchor: null,   /* 처리 바를 붙일 후원 카드 */
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

  /* ───── 도우미 ───── */

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* donated_at 은 위플랩이 준 한국 시간이라 그대로 자릅니다 */
  var when = function (s) { return String(s || '').slice(0, 16); };
  var key = function (o, i) { return o + '::' + i; };
  var findOrder = function (idx) {
    return state.orders.filter(function (x) { return x.idx === idx; })[0];
  };

  /* ───── 화면 뼈대 ───── */

  function shell() {
    return [
      '<div class="box" id="rlUnknown" style="display:none"></div>',

      '<div class="box">',
      '  <h3 class="rl-fold" id="rlMenuHead">룰렛 항목 관리 <span class="rl-arrow">▾</span></h3>',
      '  <div id="rlMenu" style="display:none"></div>',
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
      '    <input id="rlQ" placeholder="닉네임 또는 아이디" autocomplete="off">',
      '    <button class="btn sub" id="rlSets">확률표 갱신</button>',
      '  </div>',
      '  <div id="rlList" class="rl-list"></div>',
      '  <div class="actions"><button class="btn sub" id="rlMore" style="display:none">더 보기</button></div>',
      '</div>',
    ].join('');
  }

  function buildDock() {
    var d = document.createElement('div');
    d.className = 'rl-dock';
    d.innerHTML = [
      '<span class="rl-count"><b id="rlN">0</b>개 선택</span>',
      '<input id="rlMemo" placeholder="비고 (선택)" autocomplete="off">',
      '<input id="rlRef" placeholder="게시글 URL (선택)" autocomplete="off">',
      '<div class="rl-acts">',
      '  <button class="btn" data-st="done">완료</button>',
      '  <button class="btn sub" data-st="scheduled">예정</button>',
      '  <button class="btn sub" data-st="void">제외</button>',
      '  <button class="btn sub" data-clear="1">해제</button>',
      '</div>',
    ].join('');

    d.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.st) apply(b.dataset.st);
      else if (b.dataset.clear) clearSel();
    });
    return d;
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

  function menuRow(items) {
    return items.map(function (m) {
      var seg = ['instant', 'task', 'meta'].map(function (k) {
        return '<button class="rl-k' + (m.kind === k ? ' on' : '') + '" data-k="' + k +
          '" data-key="' + esc(m.label_key) + '">' + KIND[k] + '</button>';
      }).join('');
      return '<div class="rl-un-row">' +
        '<span class="rl-un-name">' + esc(m.label) + '</span>' +
        '<span class="rl-kseg">' + seg + '</span></div>';
    });
  }

  function renderMenu() {
    var wrap = document.getElementById('rlMenu');
    if (state.menu.length === 0) {
      wrap.innerHTML = '<p class="rl-empty">아직 등록된 항목이 없어요</p>';
      return;
    }
    var order = { unknown: 0, task: 1, instant: 2, meta: 3 };
    var sorted = state.menu.slice().sort(function (a, b) {
      return (order[a.kind] - order[b.kind]) || String(a.label).localeCompare(String(b.label), 'ko');
    });
    wrap.innerHTML =
      '<p class="rl-help">분류를 바꾸면 앞으로 들어올 결과에 적용됩니다. ' +
      '이미 쌓인 기록까지 바꿀지는 누를 때 물어봐요.</p>' +
      menuRow(sorted).join('');
    bindKindButtons(wrap);
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
      var picked = o.items.filter(function (it) { return state.sel[key(o.idx, it.seq)]; }).length;

      var items = o.items.map(function (it) {
        var k = key(o.idx, it.seq);
        var extra = [];
        if (it.resolved_label) extra.push('→ <b>' + esc(it.resolved_label) + '</b>');
        if (it.memo) extra.push(esc(it.memo));
        return '<label class="rl-item' + (state.sel[k] ? ' sel' : '') + '">' +
          '<input type="checkbox" data-k="' + k + '" data-order="' + esc(o.idx) + '"' +
          (state.sel[k] ? ' checked' : '') + '>' +
          '<span class="rl-label">' + esc(it.label) + '</span>' +
          '<span class="rl-pct">' + it.percent + '%</span>' +
          (extra.length ? '<span class="rl-extra">' + extra.join(' · ') + '</span>' : '') +
          '<span class="rl-st rl-' + it.status + '">' + (STATUS[it.status] || it.status) + '</span>' +
          (it.done_ref ? '<a class="rl-ref" href="' + esc(it.done_ref) + '" target="_blank">게시글</a>' : '') +
          '</label>';
      }).join('');

      return '<div class="rl-order" data-order="' + esc(o.idx) + '">' +
        '<div class="rl-head">' +
        '<b>' + esc(o.donor_name) + '</b><span class="rl-id">' + esc(o.donor_id) + '</span>' +
        '<span class="rl-amt">' + o.amount + '개</span>' +
        '<span class="rl-time">' + when(o.donated_at) + '</span>' +
        (o.msg ? '<span class="rl-msg">' + esc(o.msg) + '</span>' : '') +
        '<button class="rl-all" data-order="' + esc(o.idx) + '">' +
        (picked === o.items.length ? '전체 해제' : '전체 선택') + '</button>' +
        '</div>' + items + '</div>';
    }).join('');

    wrap.querySelectorAll('input[type=checkbox]').forEach(function (c) {
      c.addEventListener('change', function () {
        if (c.checked) state.sel[c.dataset.k] = true; else delete state.sel[c.dataset.k];
        state.anchor = c.dataset.order;
        c.closest('.rl-item').classList.toggle('sel', c.checked);
        syncOrderButton(c.dataset.order);
        placeDock();
      });
    });

    wrap.querySelectorAll('.rl-all').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var o = findOrder(b.dataset.order);
        if (!o) return;
        var all = o.items.every(function (it) { return state.sel[key(o.idx, it.seq)]; });
        o.items.forEach(function (it) {
          if (all) delete state.sel[key(o.idx, it.seq)];
          else state.sel[key(o.idx, it.seq)] = true;
        });
        state.anchor = all ? null : o.idx;
        renderList();
        placeDock();
      });
    });

    document.getElementById('rlMore').style.display = state.hasMore ? '' : 'none';
    placeDock();
  }

  /* 카드의 전체 선택/해제 라벨만 갱신 */
  function syncOrderButton(idx) {
    var o = findOrder(idx);
    var btn = document.querySelector('.rl-all[data-order="' + idx + '"]');
    if (!o || !btn) return;
    var all = o.items.every(function (it) { return state.sel[key(o.idx, it.seq)]; });
    btn.textContent = all ? '전체 해제' : '전체 선택';
  }

  /* ───── 처리 바 위치 ───── */

  function placeDock() {
    var n = Object.keys(state.sel).length;

    if (n === 0) {
      dock.classList.remove('on');
      if (dock.parentNode) dock.parentNode.removeChild(dock);
      return;
    }

    /* 선택이 남아있는 카드 중 마지막으로 건드린 곳, 없으면 첫 번째 */
    var target = state.anchor && document.querySelector('.rl-order[data-order="' + state.anchor + '"]');
    if (!target) {
      var first = Object.keys(state.sel)[0].split('::')[0];
      target = document.querySelector('.rl-order[data-order="' + first + '"]');
    }
    if (!target) return;

    dock.querySelector('#rlN').textContent = n;
    dock.classList.add('on');
    target.insertAdjacentElement('afterend', dock);
  }

  function clearSel() {
    state.sel = {};
    state.anchor = null;
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
    if (!keepOffset) { state.offset = 0; state.orders = []; state.sel = {}; state.anchor = null; }
    var qs = '?scope=task&limit=10&offset=' + state.offset +
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
    var targets = Object.keys(state.sel).map(function (k) {
      var p = k.split('::');
      return { order_idx: p[0], seq: Number(p[1]) };
    });
    if (targets.length === 0) return;

    var memo = dock.querySelector('#rlMemo').value.trim();
    var ref = dock.querySelector('#rlRef').value.trim();

    try {
      await api('/items/status', {
        method: 'POST',
        body: {
          targets: targets,
          status: status,
          memo: memo || undefined,
          done_ref: ref || undefined,
        },
      });
      say(targets.length + '개 ' + STATUS[status] + ' 처리했어요');
      state.sel = {};
      state.anchor = null;
      dock.querySelector('#rlMemo').value = '';
      dock.querySelector('#rlRef').value = '';
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
      state.offset += 10;
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
    '.rl-amt{color:#1b64da;font-weight:600}',
    '.rl-msg{color:#8b95a1;font-style:italic}',
    '.rl-all{margin-left:auto;border:0;background:none;color:#3182f6;font:inherit;font-size:12px;cursor:pointer}',
    '.rl-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:8px;font-size:13px;cursor:pointer}',
    '.rl-item:hover{background:#f8f9fa}',
    '.rl-item.sel{background:#e8f3ff}',
    '.rl-label{font-weight:600;color:#333d4b}',
    '.rl-pct{color:#b0b8c1;font-size:12px}',
    '.rl-extra{color:#6b7684;font-size:12px}',
    '.rl-st{margin-left:auto;font-size:12px;padding:2px 8px;border-radius:6px;background:#f2f4f6;color:#8b95a1}',
    '.rl-st.rl-pending{background:#fff3e0;color:#c56b00}',
    '.rl-st.rl-done{background:#e8f7ee;color:#0f8b4c}',
    '.rl-ref{font-size:12px;color:#3182f6}',
    '.rl-empty{text-align:center;color:#8b95a1;padding:36px 0;font-size:14px}',
    '.rl-help{font-size:13px;color:#6b7684;margin:-4px 0 12px}',
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
    /* 처리 바 — 선택한 카드 바로 아래에 붙습니다 */
    '.rl-dock{display:none;align-items:center;gap:8px;flex-wrap:wrap;',
    'margin:-4px 0 14px;padding:11px 13px;border-radius:12px;',
    'background:#f8fbff;border:1px solid #c9deff}',
    '.rl-dock.on{display:flex}',
    '.rl-count{font-size:13px;color:#1b64da;font-weight:600;white-space:nowrap}',
    '.rl-dock input{padding:8px 11px;border:1px solid #d1d6db;border-radius:8px;font:inherit;font-size:13px;background:#fff}',
    '.rl-dock #rlMemo{flex:3;min-width:220px}',
    '.rl-dock #rlRef{flex:2;min-width:160px}',
    '.rl-acts{display:flex;gap:6px;margin-left:auto}',
  ].join('');
  document.head.appendChild(css);
})();