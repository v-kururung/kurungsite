/* ═══════════════════════════════════════════════════════════
   룰렛 숙제 관리 — admin.html 에 붙는 탭

   admin.html 수정 3곳:
   1) 탭 버튼 추가
      <button data-t="roulette" onclick="tab('roulette')">🎯 룰렛 숙제</button>
   2) 패널 자리 추가 (다른 .panel 들 옆에)
      <div class="panel" id="p-roulette"></div>
   3) 맨 아래 인라인 <script> 다음 줄에
      <script src="admin-roulette.js"></script>
   ═══════════════════════════════════════════════════════════ */

(function () {
  var BASE = (typeof API !== 'undefined' ? API : '/api') + '/roulette';
  var token = function () {
    if (typeof DB !== 'undefined' && DB.token) return DB.token();
    return localStorage.getItem('adminToken') || '';
  };
  var say = function (m) { if (typeof toast === 'function') toast(m); };

  var state = { status: 'pending', q: '', offset: 0, orders: [], hasMore: false, sel: {}, menu: [] };

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

  /* donated_at 은 위플랩이 준 한국 시간 문자열이라 그대로 자릅니다 */
  var when = function (s) { return String(s || '').slice(0, 16); };

  var key = function (o, i) { return o + '::' + i; };

  var STATUS_LABEL = { pending: '대기', scheduled: '예정', done: '완료', void: '제외' };

  /* ───── 렌더 ───── */

  function shell() {
    return [
      '<div class="box" id="rlUnknown" style="display:none"></div>',

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

      '<div class="rl-dock" id="rlDock">',
      '  <div class="rl-dock-in">',
      '    <span class="rl-count"><b id="rlN">0</b>개 선택</span>',
      '    <input id="rlMemo" placeholder="비고 (선택)" autocomplete="off">',
      '    <div class="rl-quick">',
      '      <button data-memo="구독권 선물">구독권 선물</button>',
      '      <button data-memo="방송국 구독">방송국 구독</button>',
      '    </div>',
      '    <input id="rlSwap" placeholder="교체 항목 (선택)" autocomplete="off">',
      '    <input id="rlRef" placeholder="다시보기 링크 (선택)" autocomplete="off">',
      '    <div class="rl-acts">',
      '      <button class="btn" data-st="done">완료</button>',
      '      <button class="btn sub" data-st="scheduled">예정</button>',
      '      <button class="btn sub" data-st="void">제외</button>',
      '      <button class="btn sub" id="rlClear">해제</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderUnknown() {
    var box = document.getElementById('rlUnknown');
    var un = state.menu.filter(function (m) { return m.kind === 'unknown'; });
    if (un.length === 0) { box.style.display = 'none'; return; }

    box.style.display = '';
    box.innerHTML =
      '<h3>분류가 필요한 항목 ' + un.length + '개</h3>' +
      '<p class="rl-help">방송 중에 바로 끝나는 건 <b>즉시</b>, 나중에 해줘야 하는 건 <b>숙제</b>, ' +
      '다음 룰렛 2배처럼 해줄 일이 없는 건 <b>제외</b>를 눌러주세요.</p>' +
      '<div class="rl-un">' +
      un.map(function (m) {
        return '<div class="rl-un-row"><span class="rl-un-name">' + esc(m.label) + '</span>' +
          '<button class="btn sub" data-k="instant" data-key="' + esc(m.label_key) + '">즉시</button>' +
          '<button class="btn sub" data-k="task" data-key="' + esc(m.label_key) + '">숙제</button>' +
          '<button class="btn sub" data-k="meta" data-key="' + esc(m.label_key) + '">제외</button></div>';
      }).join('') +
      '</div>';

    box.querySelectorAll('button[data-k]').forEach(function (b) {
      b.addEventListener('click', function () {
        classify(b.dataset.key, b.dataset.k);
      });
    });
  }

  async function classify(label_key, kind) {
    try {
      await api('/menu', { method: 'POST', body: { label_key: label_key, kind: kind } });
      say(label_key + ' → ' + ({ instant: '즉시', task: '숙제', meta: '제외' }[kind]));
      await refresh();
    } catch (e) { say('분류 실패: ' + e.message); }
  }

  function renderList() {
    var wrap = document.getElementById('rlList');

    if (state.orders.length === 0) {
      wrap.innerHTML = '<p class="rl-empty">' +
        (state.status === 'pending' ? '남은 숙제가 없어요 🎉' : '해당하는 내역이 없어요') + '</p>';
      document.getElementById('rlMore').style.display = 'none';
      return;
    }

    wrap.innerHTML = state.orders.map(function (o) {
      var items = o.items.map(function (it) {
        var k = key(o.idx, it.seq);
        var pickable = it.status !== 'done' || state.status !== 'pending';
        var extra = [];
        if (it.resolved_label) extra.push('→ <b>' + esc(it.resolved_label) + '</b>');
        if (it.memo) extra.push(esc(it.memo));
        return '<label class="rl-item' + (state.sel[k] ? ' sel' : '') + '">' +
          (pickable ? '<input type="checkbox" data-k="' + k + '"' + (state.sel[k] ? ' checked' : '') + '>' : '<span class="rl-dot"></span>') +
          '<span class="rl-label">' + esc(it.label) + '</span>' +
          '<span class="rl-pct">' + it.percent + '%</span>' +
          (extra.length ? '<span class="rl-extra">' + extra.join(' · ') + '</span>' : '') +
          '<span class="rl-st rl-' + it.status + '">' + (STATUS_LABEL[it.status] || it.status) + '</span>' +
          (it.done_ref ? '<a class="rl-ref" href="' + esc(it.done_ref) + '" target="_blank">다시보기</a>' : '') +
          '</label>';
      }).join('');

      return '<div class="rl-order">' +
        '<div class="rl-head">' +
        '<b>' + esc(o.donor_name) + '</b><span class="rl-id">' + esc(o.donor_id) + '</span>' +
        '<span class="rl-amt">' + o.amount + '개</span>' +
        '<span class="rl-time">' + when(o.donated_at) + '</span>' +
        (o.msg ? '<span class="rl-msg">' + esc(o.msg) + '</span>' : '') +
        '<button class="rl-all" data-order="' + esc(o.idx) + '">전체 선택</button>' +
        '</div>' + items + '</div>';
    }).join('');

    wrap.querySelectorAll('input[type=checkbox]').forEach(function (c) {
      c.addEventListener('change', function () {
        if (c.checked) state.sel[c.dataset.k] = true; else delete state.sel[c.dataset.k];
        c.closest('.rl-item').classList.toggle('sel', c.checked);
        renderDock();
      });
    });

    wrap.querySelectorAll('.rl-all').forEach(function (b) {
      b.addEventListener('click', function () {
        var o = state.orders.filter(function (x) { return x.idx === b.dataset.order; })[0];
        if (!o) return;
        o.items.forEach(function (it) { state.sel[key(o.idx, it.seq)] = true; });
        renderList(); renderDock();
      });
    });

    document.getElementById('rlMore').style.display = state.hasMore ? '' : 'none';
  }

  function renderDock() {
    var n = Object.keys(state.sel).length;
    document.getElementById('rlN').textContent = n;
    document.getElementById('rlDock').classList.toggle('on', n > 0);
  }

  function renderSum(s) {
    document.getElementById('rlSum').innerHTML =
      '<span class="rl-chip wait">대기 <b>' + s.pending + '</b></span>' +
      '<span class="rl-chip done">완료 <b>' + s.done + '</b></span>' +
      (s.unclassified ? '<span class="rl-chip warn">미분류 <b>' + s.unclassified + '</b></span>' : '');
  }

  /* ───── 동작 ───── */

  async function refresh(keepOffset) {
    if (!keepOffset) { state.offset = 0; state.orders = []; }
    var qs = '?scope=task&limit=10&offset=' + state.offset +
      (state.status ? '&status=' + state.status : '') +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '');

    var res = await Promise.all([api('/stats'), api('/menu'), api('/list' + qs)]);
    renderSum(res[0]);
    state.menu = res[1].menu || [];
    renderUnknown();

    state.orders = state.offset === 0 ? res[2].orders : state.orders.concat(res[2].orders);
    state.hasMore = res[2].hasMore;
    renderList();
    renderDock();
  }

  async function apply(status) {
    var targets = Object.keys(state.sel).map(function (k) {
      var p = k.split('::');
      return { order_idx: p[0], seq: Number(p[1]) };
    });
    if (targets.length === 0) return;

    var memo = document.getElementById('rlMemo').value.trim();
    var swap = document.getElementById('rlSwap').value.trim();
    var ref = document.getElementById('rlRef').value.trim();

    try {
      await api('/items/status', {
        method: 'POST',
        body: {
          targets: targets,
          status: status,
          memo: memo || undefined,
          resolved_label: swap || undefined,
          done_ref: ref || undefined,
        },
      });
      say(targets.length + '개 ' + STATUS_LABEL[status] + ' 처리했어요');
      state.sel = {};
      ['rlMemo', 'rlSwap', 'rlRef'].forEach(function (id) { document.getElementById(id).value = ''; });
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
    ready = true;

    document.getElementById('rlTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-s]');
      if (!b) return;
      state.status = b.dataset.s;
      state.sel = {};
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

    var dock = document.getElementById('rlDock');
    dock.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.st) apply(b.dataset.st);
      else if (b.dataset.memo) document.getElementById('rlMemo').value = b.dataset.memo;
      else if (b.id === 'rlClear') { state.sel = {}; renderList(); renderDock(); }
    });

    refresh();
  }

  /* 탭을 처음 열 때 불러옵니다 */
  var origTab = window.tab;
  window.tab = function (n) {
    origTab(n);
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
    '.rl-dot{width:13px;height:13px;border-radius:50%;background:#e5e8eb;flex:0 0 auto}',
    '.rl-label{font-weight:600;color:#333d4b}',
    '.rl-pct{color:#b0b8c1;font-size:12px}',
    '.rl-extra{color:#6b7684;font-size:12px}',
    '.rl-st{margin-left:auto;font-size:12px;padding:2px 8px;border-radius:6px;background:#f2f4f6;color:#8b95a1}',
    '.rl-st.rl-pending{background:#fff3e0;color:#c56b00}',
    '.rl-st.rl-done{background:#e8f7ee;color:#0f8b4c}',
    '.rl-ref{font-size:12px;color:#3182f6}',
    '.rl-empty{text-align:center;color:#8b95a1;padding:36px 0;font-size:14px}',
    '.rl-help{font-size:13px;color:#6b7684;margin:-4px 0 12px}',
    '.rl-un-row{display:flex;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid #f2f4f6}',
    '.rl-un-name{flex:1;font-weight:600;font-size:14px}',
    '.rl-un-row .btn{padding:5px 12px;font-size:12px}',
    '.rl-dock{position:sticky;bottom:0;margin-top:14px;display:none}',
    '.rl-dock.on{display:block}',
    '.rl-dock-in{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:12px;background:#fff;border:1px solid #d1d6db;box-shadow:0 -2px 16px rgba(0,0,0,.08)}',
    '.rl-count{font-size:13px;color:#4e5968;white-space:nowrap}',
    '.rl-dock-in input{padding:8px 11px;border:1px solid #e5e8eb;border-radius:8px;font:inherit;font-size:13px;min-width:130px;flex:1}',
    '.rl-quick{display:flex;gap:4px}',
    '.rl-quick button{padding:6px 10px;border:1px solid #e5e8eb;border-radius:7px;background:#fff;font:inherit;font-size:12px;color:#4e5968;cursor:pointer;white-space:nowrap}',
    '.rl-quick button:hover{background:#f2f4f6}',
    '.rl-acts{display:flex;gap:6px;margin-left:auto}',
  ].join('');
  document.head.appendChild(css);
})();