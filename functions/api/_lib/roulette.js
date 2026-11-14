/* ═══════════════════════════════════════════════════════════
   룰렛 주문내역 API — Cloudflare Pages Functions 용

   functions/api/[[route]].js 에서 이렇게 불러 씁니다:

     import { handleRoulette } from './_lib/roulette.js';

     // onRequest 안, seg 분기들 사이에
     if (seg === 'roulette') {
       return await handleRoulette({ request, env, parts, admin: isAdmin(request, env) });
     }

   인증은 기존 ADMIN_TOKEN(X-Admin-Token 헤더)을 그대로 씁니다.
   추가로 필요한 환경변수는 ROULETTE_PUBLIC_KEY 하나뿐입니다.
   (위플랩 공개 확률표 주소 https://weflab.com/user/<이 값>)
   ═══════════════════════════════════════════════════════════ */

import { syncRouletteSets, currentSets } from './roulette-sets.js';

/* 확장이 weflab.com에서 호출하므로 이 경로에만 CORS를 열어둡니다 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const denied = () => json({ error: 'unauthorized' }, 401);

/* ------------------------------------------------------------------ *
 * 정규화
 * ------------------------------------------------------------------ */

/** 이모지·변형선택자 제거 → 메뉴 매칭용 키 */
export const normKey = (s) =>
  String(s)
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 위플랩 alertlist 레코드 → 우리 구조. 룰렛 결과가 없으면 null.
 *
 * list 는 연차(여러 회) 후원에만 채워집니다. 330개처럼 11회 돌아가는 건
 * list 에 결과가 전부 들어오지만, 33개 단차는 list 가 비어 있고
 * roulette / percent 에만 값이 옵니다. 그 경우 한 건짜리 목록으로 만듭니다.
 */
export function parseRecord(r) {
  if (!r.idx) return null;

  let list;
  try {
    list = JSON.parse(r.list || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  if (list.length === 0 && r.roulette) list = [[r.roulette, r.percent]];
  if (list.length === 0) return null;

  return {
    idx: String(r.idx),
    no: r.no ?? null,
    uid: r.uid ?? null,
    platform: r.platform ?? null,
    type: r.type ?? null,
    subtype: r.subtype ?? null,
    donor_id: r.id ?? null,
    donor_name: r.name ?? null,
    amount: Number(r.value) || 0,
    msg: r.msg ?? '',
    donated_at: r.create_time ?? null,
    stream_start: r.start ?? null,
    spin_count: list.length,
    items: list.map(([label, pct], i) => ({
      seq: i,
      label: String(label ?? ''),
      label_key: normKey(label ?? ''),
      percent: Number(pct) || 0,
    })),
  };
}

/**
 * 분류별 첫 상태
 *   instant → done    방송 중 바로 끝남
 *   meta    → void    다음 룰렛 2배처럼 해줄 일이 없음
 *   coupon  → held    교환권처럼 들고 있다가 다른 숙제에 얹어 쓰는 것
 *   그 외   → pending 숙제
 */
function statusForKind(kind) {
  if (kind === 'instant') return 'done';
  if (kind === 'meta') return 'void';
  if (kind === 'coupon') return 'held';
  return 'pending';
}

/* 숙제 카운트에서 빼는 분류 */
const NOT_TASK = `('instant','meta','coupon')`;

/** bice0905 → bic***05 */
function maskId(id) {
  if (!id) return '';
  const s = String(id);
  if (s.length <= 4) return s[0] + '*'.repeat(s.length - 1);
  return s.slice(0, 3) + '*'.repeat(Math.max(2, s.length - 5)) + s.slice(-2);
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* ------------------------------------------------------------------ *
 * 라우터 — parts 는 ['roulette', 'sync'] 같은 형태입니다
 * ------------------------------------------------------------------ */

export async function handleRoulette({ request, env, parts, admin }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const sub = parts[1] || '';
  const sub2 = parts[2] || '';
  const m = request.method;

  try {
    if (sub === 'sync' && m === 'POST') return admin ? await sync(request, env) : denied();
    if (sub === 'list' && m === 'GET') return await list(request, env, admin);
    if (sub === 'stats' && m === 'GET') return await stats(env);
    if (sub === 'donors' && m === 'GET') return await donors(request, env);
    if (sub === 'sets' && !sub2 && m === 'GET') return json(await currentSets(env));

    if (sub === 'sets' && sub2 === 'sync' && m === 'POST') {
      if (!admin) return denied();
      const force = new URL(request.url).searchParams.get('force') === '1';
      return json(await syncRouletteSets(env, { force }));
    }

    if (sub === 'manual' && !sub2 && m === 'POST') return admin ? await manualAdd(request, env) : denied();
    if (sub === 'manual' && sub2 === 'delete' && m === 'POST') {
      return admin ? await manualDelete(request, env) : denied();
    }
    if (sub === 'manual' && sub2 === 'update' && m === 'POST') {
      return admin ? await manualUpdate(request, env) : denied();
    }

    /* 시청자가 코드로 자기 요청을 쓰는 창구 — 로그인 없이 열립니다 */
    if (sub === 'my' && m === 'GET') return await myItems(request, env);
    if (sub === 'my' && sub2 === 'upload' && m === 'POST') return await myUpload(request, env);
    if (sub === 'my' && m === 'POST') return await myWrite(request, env);
    if (sub === 'code' && m === 'POST') return admin ? await issueCode(request, env) : denied();

    if (sub === 'menu' && m === 'GET') return admin ? await menuList(env) : denied();
    if (sub === 'menu' && m === 'POST') return admin ? await menuClassify(request, env) : denied();
    if (sub === 'bonus' && !sub2 && m === 'GET') return admin ? await bonusList(env) : denied();
    if (sub === 'bonus' && !sub2 && m === 'POST') return admin ? await bonusSave(request, env) : denied();
    if (sub === 'bonus' && sub2 === 'delete' && m === 'POST') return admin ? await bonusDelete(request, env) : denied();
    if (sub === 'coupon' && sub2 === 'use' && m === 'POST') return admin ? await couponUse(request, env) : denied();
    if (sub === 'coupon' && sub2 === 'undo' && m === 'POST') return admin ? await couponUndo(request, env) : denied();
    if (sub === 'items' && sub2 === 'status' && m === 'POST') {
      return admin ? await itemStatus(request, env) : denied();
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', detail: String(err?.message || err) }, 500);
  }
}

/* ------------------------------------------------------------------ *
 * POST /api/roulette/sync
 * body: { records: [ ...위플랩 alertlist data 배열 그대로... ] }
 * ------------------------------------------------------------------ */

async function sync(request, env) {
  const body = await request.json().catch(() => ({}));
  const records = Array.isArray(body.records) ? body.records : [];
  const empty = { ok: true, received: records.length, newOrders: 0, newItems: 0, newTasks: 0, unknown: [] };
  if (records.length === 0) return json(empty);

  const orders = records.map(parseRecord).filter(Boolean);
  if (orders.length === 0) return json(empty);

  /* 1) 이번 배치에 등장한 룰렛 항목 → 메뉴에 자동 등록(신규는 unknown) */
  const seen = new Map();
  for (const o of orders) {
    for (const it of o.items) {
      const prev = seen.get(it.label_key);
      if (!prev || prev.at < o.donated_at) seen.set(it.label_key, { label: it.label, at: o.donated_at });
    }
  }
  await env.DB.batch(
    [...seen].map(([key, v]) =>
      env.DB.prepare(
        `INSERT INTO roulette_menu (label_key, label, kind, first_seen, last_seen)
         VALUES (?1, ?2, 'unknown', ?3, ?3)
         ON CONFLICT(label_key) DO UPDATE SET
           label = excluded.label,
           last_seen = MAX(COALESCE(roulette_menu.last_seen, ''), excluded.last_seen)`
      ).bind(key, v.label, v.at)
    )
  );

  /* 2) 확정된 분류 읽기 */
  const menuRows = await env.DB.prepare(`SELECT label_key, kind FROM roulette_menu`).all();
  const menu = new Map(menuRows.results.map((x) => [x.label_key, x.kind]));

  /* 3) 기존 주문 조회 — 신규 건수를 정확히 세기 위해 */
  const known = new Set();
  for (const part of chunk(orders.map((o) => o.idx), 80)) {
    const q = await env.DB.prepare(
      `SELECT idx FROM roulette_orders WHERE idx IN (${part.map(() => '?').join(',')})`
    ).bind(...part).all();
    q.results.forEach((r) => known.add(String(r.idx)));
  }

  /* 4) 저장 */
  const stmts = [];
  const itemKinds = [];
  for (const o of orders) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO roulette_orders
           (idx,no,uid,platform,type,subtype,donor_id,donor_name,amount,msg,donated_at,stream_start,spin_count,synced_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,datetime('now'))
         ON CONFLICT(idx) DO UPDATE SET
           donor_name = excluded.donor_name,
           msg        = excluded.msg,
           synced_at  = excluded.synced_at`
      ).bind(
        o.idx, o.no, o.uid, o.platform, o.type, o.subtype,
        o.donor_id, o.donor_name, o.amount, o.msg,
        o.donated_at, o.stream_start, o.spin_count
      )
    );
    itemKinds.push(null);

    for (const it of o.items) {
      const kind = menu.get(it.label_key) ?? 'unknown';
      const instant = kind === 'instant';
      const status = statusForKind(kind);
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO roulette_items
             (order_idx,seq,label,label_key,percent,kind,status,done_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
        ).bind(o.idx, it.seq, it.label, it.label_key, it.percent, kind, status, instant ? o.donated_at : null)
      );
      itemKinds.push(kind);
    }
  }

  let newItems = 0;
  let newTasks = 0;
  let cursor = 0;
  for (const part of chunk(stmts, 100)) {
    const results = await env.DB.batch(part);
    results.forEach((res, i) => {
      const kind = itemKinds[cursor + i];
      if (kind === null) return;
      if ((res?.meta?.changes ?? 0) > 0) {
        newItems++;
        if (kind !== 'instant' && kind !== 'meta' && kind !== 'coupon') newTasks++;
      }
    });
    cursor += part.length;
  }

  const unknown = [...seen.keys()].filter((k) => (menu.get(k) ?? 'unknown') === 'unknown');
  const newOrders = orders.filter((o) => !known.has(o.idx)).length;
  const latest = orders.reduce((a, o) => (o.donated_at > a ? o.donated_at : a), '');

  /* 4-1) 금액 조건 보너스 — 500개 통후원이면 확정 방셀 같은 것 */
  let bonus = 0;
  try {
    bonus = await applyBonusRules(env, orders.map((o) => ({ idx: o.idx, amount: o.amount, donated_at: o.donated_at })));
    newTasks += bonus;
  } catch (_) {}

  /* 5) 확률표도 하루 한 번 정도 같이 확인합니다.
        Pages Functions에는 크론이 없어서 동기화에 얹었습니다. 실패해도 무시합니다. */
  let sets = null;
  try {
    sets = await maybeSyncSets(env);
  } catch (_) {}

  return json({ ok: true, received: records.length, newOrders, newItems, newTasks, bonus, unknown, latest, sets });
}

/* ------------------------------------------------------------------ *
 * 보너스 규칙
 *
 * 룰렛과 별개로, 후원 금액 조건으로 자동 생성되는 숙제입니다.
 * 예) 11월에 정확히 500의 배수로 한 번에 후원 → 500개당 '11월 확정 방셀' 1개
 *
 * roulette_bonus_rules
 *   id, label, amount(단위), mode('multiple' 배수만 | 'floor' 단위로 나눠 버림 | 'min' 이상이면 1개),
 *   from_date, to_date (YYYY-MM-DD, 비우면 무제한), active
 * ------------------------------------------------------------------ */

async function ensureBonusTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS roulette_bonus_rules (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       label TEXT NOT NULL,
       amount INTEGER NOT NULL,
       mode TEXT NOT NULL DEFAULT 'multiple',
       from_date TEXT,
       to_date TEXT,
       active INTEGER DEFAULT 1,
       created_at TEXT
     )`
  ).run();
}

/** 규칙 하나에 대해 이 후원이 몇 개를 받는지 */
function bonusCount(rule, amount, donatedAt) {
  if (!rule.active) return 0;
  const day = String(donatedAt || '').slice(0, 10);
  if (rule.from_date && day < rule.from_date) return 0;
  if (rule.to_date && day > rule.to_date) return 0;
  const unit = Number(rule.amount) || 0;
  if (unit <= 0 || amount <= 0) return 0;
  if (rule.mode === 'min') return amount >= unit ? 1 : 0;
  if (rule.mode === 'floor') return Math.floor(amount / unit);
  /* multiple — 정확히 배수일 때만 */
  return amount % unit === 0 ? amount / unit : 0;
}

/**
 * 후원 목록에 보너스 항목을 붙입니다. 이미 붙어 있으면 건너뜁니다.
 * 보너스 항목은 seq 1000 이상, label_key 'bonus:<rule id>' 로 구분합니다.
 * 돌려주는 값은 새로 만든 개수.
 */
async function applyBonusRules(env, orders) {
  await ensureBonusTable(env);
  const rules = (await env.DB.prepare(
    `SELECT * FROM roulette_bonus_rules WHERE active = 1`
  ).all()).results;
  if (rules.length === 0 || orders.length === 0) return 0;

  const stmts = [];
  for (const o of orders) {
    for (const r of rules) {
      const n = bonusCount(r, Number(o.amount) || 0, o.donated_at);
      for (let i = 0; i < n; i++) {
        const seq = 1000 + r.id * 10 + i;      /* 규칙당 최대 10개 */
        if (i >= 10) break;
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO roulette_items
               (order_idx,seq,label,label_key,percent,kind,status)
             VALUES (?1,?2,?3,?4,0,'task','pending')`
          ).bind(o.idx, seq, r.label, 'bonus:' + r.id)
        );
      }
    }
  }
  if (stmts.length === 0) return 0;

  let made = 0;
  for (const part of chunk(stmts, 100)) {
    const res = await env.DB.batch(part);
    res.forEach((x) => { if ((x?.meta?.changes ?? 0) > 0) made++; });
  }
  return made;
}

/** 규칙을 과거 후원 전체에 적용. 관리자 화면의 '소급 적용' 버튼 */
async function bonusBackfill(env, ruleId) {
  const rows = (await env.DB.prepare(
    `SELECT idx, amount, donated_at FROM roulette_orders`
  ).all()).results;
  /* 한 규칙만 적용하려면 다른 규칙은 잠시 빼고 돌립니다 */
  const rules = (await env.DB.prepare(
    `SELECT * FROM roulette_bonus_rules WHERE id = ?1 AND active = 1`
  ).bind(ruleId).all()).results;
  if (!rules.length) return 0;

  const stmts = [];
  const r = rules[0];
  for (const o of rows) {
    const n = bonusCount(r, Number(o.amount) || 0, o.donated_at);
    for (let i = 0; i < Math.min(n, 10); i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO roulette_items
             (order_idx,seq,label,label_key,percent,kind,status)
           VALUES (?1,?2,?3,?4,0,'task','pending')`
        ).bind(o.idx, 1000 + r.id * 10 + i, r.label, 'bonus:' + r.id)
      );
    }
  }
  let made = 0;
  for (const part of chunk(stmts, 100)) {
    const res = await env.DB.batch(part);
    res.forEach((x) => { if ((x?.meta?.changes ?? 0) > 0) made++; });
  }
  return made;
}

async function bonusList(env) {
  await ensureBonusTable(env);
  const r = await env.DB.prepare(
    `SELECT b.*,
            (SELECT COUNT(*) FROM roulette_items i WHERE i.label_key = 'bonus:' || b.id) AS given,
            (SELECT COUNT(*) FROM roulette_items i WHERE i.label_key = 'bonus:' || b.id AND i.status = 'pending') AS pending
       FROM roulette_bonus_rules b
      ORDER BY b.active DESC, b.id DESC`
  ).all();
  return json({ rules: r.results });
}

/** POST /bonus — { id?, label, amount, mode, from_date, to_date, active, backfill? } */
async function bonusSave(request, env) {
  await ensureBonusTable(env);
  const b = await request.json().catch(() => ({}));
  const label = String(b.label || '').trim();
  const amount = Number(b.amount) || 0;
  const mode = ['multiple', 'floor', 'min'].includes(b.mode) ? b.mode : 'multiple';
  if (!label || amount <= 0) return json({ error: 'bad_request' }, 400);

  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const from = day(b.from_date), to = day(b.to_date);
  const active = b.active === false || b.active === 0 ? 0 : 1;

  let id = Number(b.id) || 0;
  if (id) {
    await env.DB.prepare(
      `UPDATE roulette_bonus_rules
          SET label=?1, amount=?2, mode=?3, from_date=?4, to_date=?5, active=?6
        WHERE id=?7`
    ).bind(label, amount, mode, from, to, active, id).run();
    /* 이름이 바뀌면 이미 만든 항목의 이름도 따라갑니다 (처리 안 된 것만) */
    await env.DB.prepare(
      `UPDATE roulette_items SET label=?1 WHERE label_key=?2 AND status='pending'`
    ).bind(label, 'bonus:' + id).run();
  } else {
    const ins = await env.DB.prepare(
      `INSERT INTO roulette_bonus_rules (label, amount, mode, from_date, to_date, active, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,datetime('now','+9 hours'))`
    ).bind(label, amount, mode, from, to, active).run();
    id = ins.meta.last_row_id;
  }

  let made = 0;
  if (b.backfill && active) made = await bonusBackfill(env, id);
  return json({ ok: true, id, made });
}

/** POST /bonus/delete — { id }. 아직 처리 안 된 보너스 항목도 같이 지웁니다 */
async function bonusDelete(request, env) {
  const { id } = await request.json().catch(() => ({}));
  const n = Number(id) || 0;
  if (!n) return json({ error: 'bad_request' }, 400);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM roulette_items WHERE label_key = ?1 AND status = 'pending'`).bind('bonus:' + n),
    env.DB.prepare(`DELETE FROM roulette_bonus_rules WHERE id = ?1`).bind(n),
  ]);
  return json({ ok: true });
}

/** 마지막 확인이 12시간을 넘었을 때만 공개 확률표를 다시 읽습니다 */
async function maybeSyncSets(env) {
  const KEY = 'roulette_sets_checked_at';
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();

  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first();
  const last = row?.value ? Date.parse(row.value) : 0;
  if (Date.now() - last < 12 * 3600 * 1000) return null;

  const result = await syncRouletteSets(env);
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(KEY, new Date().toISOString()).run();

  return result;
}

/* ------------------------------------------------------------------ *
 * GET /api/roulette/list — 방문자용 주문내역
 * ?scope=task|all  ?status=pending|done  ?q=닉네임·아이디·보상·비고·게시글 주소  ?month=YYYY-MM  ?limit=&offset=
 * ------------------------------------------------------------------ */

async function list(request, env, admin) {
  const u = new URL(request.url);
  const scope = u.searchParams.get('scope') === 'all' ? 'all' : 'task';
  const status = u.searchParams.get('status') || '';
  const q = (u.searchParams.get('q') || '').trim();
  /* 월 필터 — 'YYYY-MM' (후원 시각 기준) */
  const month = /^\d{4}-\d{2}$/.test(u.searchParams.get('month') || '') ? u.searchParams.get('month') : '';
  const limit = Math.min(Number(u.searchParams.get('limit')) || 10, 200);
  const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
  /* 관리자는 오래된 순(먼저 받은 숙제부터), 방문자 화면은 최신순이 자연스럽습니다 */
  const dir = u.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';

  /* 주문을 고를 때 쓰는 조건 — 상태 필터를 포함합니다 */
  const itemCond = [];
  const itemArgs = [];
  /* 관리자 목록에는 쿠폰(보유/사용)도 함께 보입니다.
     대기 탭이면 보유 중인 쿠폰, 완료 탭이면 사용한 쿠폰이 같이 나옵니다. */
  if (scope === 'task') itemCond.push(`i.kind NOT IN ('instant','meta')`);
  if (status === 'pending') itemCond.push(`i.status IN ('pending','held')`);
  else if (status === 'done') itemCond.push(`i.status IN ('done','used')`);
  else if (status) { itemCond.push(`i.status = ?`); itemArgs.push(status); }
  const itemWhere = itemCond.length ? ` AND ${itemCond.join(' AND ')}` : '';

  /* 화면에도 같은 조건을 그대로 적용합니다.
     대신 카드 머리에 그 후원의 전체 진행도(완료 n/전체 m)를 함께 내려줍니다. */
  const showWhere = itemWhere.replace(/\bi\./g, '');

  /* 닉네임·아이디뿐 아니라 보상 이름과 비고로도 찾습니다.
     보상 이름으로 찾을 때도 지금 보고 있는 상태(대기/완료)를 그대로 지켜야
     "대기 탭인데 완료된 구독권 때문에 걸려 나오는" 일이 없습니다. */
  const searchItemCond = [];
  const searchItemArgs = [];
  if (scope === 'task') searchItemCond.push(`s.kind NOT IN ('instant','meta')`);
  if (status === 'pending') searchItemCond.push(`s.status IN ('pending','held')`);
  else if (status === 'done') searchItemCond.push(`s.status IN ('done','used')`);
  else if (status) { searchItemCond.push(`s.status = ?`); searchItemArgs.push(status); }
  const searchItemWhere = searchItemCond.length ? ` AND ${searchItemCond.join(' AND ')}` : '';

  /* 게시글 주소로도 찾습니다 — 완료 처리 때 적은 done_ref 와 비교합니다.
     주소를 통째로 붙여 넣어도 되고, /post/숫자 만 있으면 호스트가 달라도(afreecatv/sooplive) 잡힙니다.

     LIKE 대신 instr()을 씁니다. D1(SQLite)은 LIKE 패턴이 조금만 길어도
     "LIKE or GLOB pattern too complex"로 막혀서 주소처럼 긴 검색어가 안 들어가요.
     대소문자는 lower()로 맞춥니다. */
  const postNo = (q.match(/\/post\/(\d+)/) || [])[1] || '';
  const needle = q.toLowerCase();
  const refNeedle = postNo ? `/post/${postNo}` : needle;
  const has = (col) => `instr(lower(COALESCE(${col}, '')), ?) > 0`;

  const searchWhere = q
    ? ` AND (${has('o.donor_name')} OR ${has('o.donor_id')} OR ${has('o.msg')}
             OR EXISTS (SELECT 1 FROM roulette_items s
                         WHERE s.order_idx = o.idx${searchItemWhere}
                           AND (${has('s.label')} OR ${has('s.memo')} OR ${has('s.resolved_label')}
                                OR ${has('s.done_ref')} OR ${has('s.request')} OR ${has('s.reply')})))`
    : '';
  const searchArgs = q
    ? [needle, needle, needle, ...searchItemArgs,
       needle, needle, needle, refNeedle, needle, needle]
    : [];

  const monthWhere = month ? ` AND substr(o.donated_at, 1, 7) = ?` : '';
  const monthArgs = month ? [month] : [];

  /* 월 목록 — 지금 보고 있는 상태(대기/완료)에 해당하는 주문이 있는 달만.
     그래서 대기 탭에서는 숙제가 모두 끝난 달이 자연스럽게 사라집니다. */
  const monthsQ = await env.DB.prepare(
    `SELECT DISTINCT substr(o.donated_at, 1, 7) AS m
       FROM roulette_orders o
      WHERE EXISTS (SELECT 1 FROM roulette_items i WHERE i.order_idx = o.idx${itemWhere})
      ORDER BY m ASC`
  ).bind(...itemArgs).all();
  const months = monthsQ.results.map((r) => r.m).filter(Boolean);

  const ordersQ = await env.DB.prepare(
    `SELECT o.*,
       (SELECT COUNT(*) FROM roulette_items t
         WHERE t.order_idx = o.idx AND t.kind NOT IN ${NOT_TASK}) AS task_total,
       (SELECT COUNT(*) FROM roulette_items t
         WHERE t.order_idx = o.idx AND t.kind NOT IN ${NOT_TASK} AND t.status = 'done') AS task_done,
       (SELECT c.code FROM roulette_codes c WHERE c.donor_id = o.donor_id) AS code
       FROM roulette_orders o
      WHERE EXISTS (SELECT 1 FROM roulette_items i WHERE i.order_idx = o.idx${itemWhere})
      ${searchWhere}${monthWhere}
      ORDER BY o.donated_at ${dir}
      LIMIT ? OFFSET ?`
  ).bind(...itemArgs, ...searchArgs, ...monthArgs, limit, offset).all();

  const rows = ordersQ.results;
  if (rows.length === 0) return json({ orders: [], hasMore: false, months, wallet: [] });

  const ids = rows.map((r) => r.idx);

  /* 쿠폰 지갑 — 이 페이지에 나온 후원자들이 보유 중인 쿠폰 전부.
     월 필터·페이지와 상관없이 가져와서, 다른 달에 받은 쿠폰도 태그로 보이게 합니다. (관리자만) */
  let wallet = [];
  if (admin) {
    const donorIds = [...new Set(rows.map((r) => r.donor_id).filter(Boolean))];
    if (donorIds.length) {
      const w = await env.DB.prepare(
        `SELECT o.idx AS order_idx, o.donor_id, o.donated_at,
                i.seq, i.label, i.kind, i.status, i.request, i.request_at,
                i.request_image, i.request_email, i.reply, i.reply_at
           FROM roulette_items i
           JOIN roulette_orders o ON o.idx = i.order_idx
          WHERE i.kind = 'coupon' AND i.status = 'held'
            AND o.donor_id IN (${donorIds.map(() => '?').join(',')})
          ORDER BY o.donated_at ASC, i.seq ASC`
      ).bind(...donorIds).all();
      wallet = w.results;
    }
  }
  const itemsQ = await env.DB.prepare(
    `SELECT x.order_idx, x.seq, x.label, x.percent, x.kind, x.status, x.done_at, x.done_ref, x.memo,
            x.resolved_label, x.image_url, x.request, x.request_at,
            x.request_image, x.request_email, x.reply, x.reply_at, x.used_for,
            (SELECT COUNT(*) FROM roulette_items c
              WHERE c.kind = 'coupon'
                AND c.used_for = x.order_idx || '::' || x.seq) AS coupon_used
       FROM roulette_items x
      WHERE x.order_idx IN (${ids.map(() => '?').join(',')})${showWhere.replace(/ AND /g, ' AND x.')}
      ORDER BY x.seq`
  ).bind(...ids, ...itemArgs).all();

  const grouped = new Map(ids.map((id) => [id, []]));
  itemsQ.results.forEach((it) => grouped.get(it.order_idx)?.push(it));

  return json({
    orders: rows.map((o) => ({
      idx: o.idx,
      donor_name: o.donor_name,
      donor_id: admin ? o.donor_id : maskId(o.donor_id),
      amount: o.amount,
      msg: o.msg,
      donated_at: o.donated_at,
      stream_start: o.stream_start,
      spin_count: o.spin_count,
      task_total: o.task_total,
      task_done: o.task_done,
      code: admin ? o.code : undefined,
      items: grouped.get(o.idx) || [],
    })),
    hasMore: rows.length === limit,
    months,
    wallet,
  });
}

/* ------------------------------------------------------------------ *
 * GET /api/roulette/donors — 주문내역 페이지용
 *
 * 후원자별로 묶어서 대기 중인 숙제와 완료 건수를 내려줍니다.
 * 정렬은 오래 기다린 사람이 먼저, 같으면 대기가 많은 사람이 먼저.
 * ------------------------------------------------------------------ */

async function donors(request, env) {
  const u = new URL(request.url);
  const q = (u.searchParams.get('q') || '').trim();
  /* new = 최근에 후원한 분부터, old = 오래 기다린 분부터(기본) */
  const newest = u.searchParams.get('order') === 'new';

  /* LIKE 는 D1에서 긴 검색어에 막히므로(pattern too complex) instr() 로 찾습니다 */
  const where = q
    ? `AND (instr(lower(COALESCE(o.donor_name, '')), ?1) > 0 OR instr(lower(COALESCE(o.donor_id, '')), ?1) > 0)`
    : '';
  const args = q ? [q.toLowerCase()] : [];

  const rows = await env.DB.prepare(
    `SELECT o.donor_id,
            (SELECT o2.donor_name FROM roulette_orders o2
              WHERE o2.donor_id = o.donor_id
              ORDER BY o2.donated_at DESC LIMIT 1) AS donor_name,
            SUM(CASE WHEN i.status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN i.status = 'done'    THEN 1 ELSE 0 END) AS done,
            MIN(CASE WHEN i.status = 'pending' THEN o.donated_at END) AS oldest_pending,
            MAX(o.donated_at) AS last_donated
       FROM roulette_orders o
       JOIN roulette_items i ON i.order_idx = o.idx
      WHERE i.kind NOT IN ('instant','meta') ${where}
      GROUP BY o.donor_id
     HAVING pending > 0 OR done > 0 OR SUM(CASE WHEN i.status = 'held' THEN 1 ELSE 0 END) > 0
      ORDER BY ${newest
        ? 'last_donated DESC'
        : '(oldest_pending IS NULL), oldest_pending ASC, pending DESC, last_donated DESC'}`
  ).bind(...args).all();

  const list = rows.results;
  if (list.length === 0) return json({ donors: [] });

  /* 대기·완료 항목을 함께 받아 각 후원자에 붙입니다.
     done_ref(게시글 주소)·image_url(작업 스크린샷)·request(본인만 보는 요청)는
     공개 화면에 나가면 안 되므로 아예 조회하지 않습니다.
     다만 "요청을 적어뒀는지" 여부(참/거짓)만은 내려줘서 코드 입력 전에도 '입력 완료'를 보여줍니다. */
  const ids = list.map((d) => d.donor_id);
  const items = await env.DB.prepare(
    `SELECT o.donor_id, o.donated_at, i.order_idx, i.seq, i.status, i.label,
            i.memo, i.resolved_label, i.done_at,
            COALESCE(mn.needs_input, 0) AS needs_input,
            CASE WHEN (i.request IS NOT NULL AND TRIM(i.request) <> '')
                   OR (i.request_image IS NOT NULL AND i.request_image <> '')
                   OR (i.request_email IS NOT NULL AND i.request_email <> '')
                 THEN 1 ELSE 0 END AS has_request
       FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
       LEFT JOIN roulette_menu mn ON mn.label_key = i.label_key
      WHERE i.status IN ('pending','done')
        AND i.kind NOT IN ${NOT_TASK}
        AND o.donor_id IN (${ids.map(() => '?').join(',')})
      ORDER BY o.donated_at ASC, i.seq ASC`
  ).bind(...ids).all();

  /* 보유 중인 쿠폰과, 어느 숙제에 쿠폰을 썼는지 */
  const coupons = await env.DB.prepare(
    `SELECT o.donor_id, i.label, i.status, i.used_for
       FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
      WHERE i.kind = 'coupon'
        AND i.status IN ('held','used')
        AND o.donor_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const heldBy = new Map(ids.map((id) => [id, []]));
  const usedOn = new Set();
  coupons.results.forEach((c) => {
    if (c.status === 'held') heldBy.get(c.donor_id)?.push(c.label);
    else if (c.used_for) usedOn.add(c.used_for);
  });

  const byDonor = new Map(ids.map((id) => [id, { items: [], done: [] }]));
  items.results.forEach((it) => {
    const bucket = byDonor.get(it.donor_id);
    if (!bucket) return;
    const row = {
      order_idx: it.order_idx,
      seq: it.seq,
      label: it.label,
      donated_at: it.donated_at,
      memo: it.memo,
      resolved_label: it.resolved_label,
      /* 요청을 적어야 하는 항목인지. 내용 자체는 코드가 있어야 볼 수 있습니다 */
      needs_input: it.needs_input ? 1 : 0,
      /* 요청을 이미 적어뒀는지 (내용은 안 나감) */
      has_request: it.has_request ? 1 : 0,
      /* 교환권을 얹어 승급된 숙제 */
      coupon_used: usedOn.has(it.order_idx + '::' + it.seq) ? 1 : 0,
    };
    if (it.status === 'done') bucket.done.push({ ...row, done_at: it.done_at });
    else bucket.items.push(row);
  });

  /* 완료 목록은 최근에 해드린 것부터 */
  byDonor.forEach((b) => b.done.sort((x, y) =>
    String(y.done_at || '').localeCompare(String(x.done_at || ''))));

  return json({
    donors: list.map((d) => ({
      donor_id: d.donor_id,
      donor_name: d.donor_name,
      pending: d.pending,
      done: d.done,
      oldest_pending: d.oldest_pending,
      items: byDonor.get(d.donor_id)?.items || [],
      done_items: byDonor.get(d.donor_id)?.done || [],
      /* 보유 쿠폰 — 같은 이름끼리 묶어서 개수로 */
      coupons: Object.entries(
        (heldBy.get(d.donor_id) || []).reduce((m, l) => (m[l] = (m[l] || 0) + 1, m), {})
      ).map(([label, count]) => ({ label, count })),
    })),
  });
}

/* ------------------------------------------------------------------ *
 * GET /api/roulette/stats
 * ------------------------------------------------------------------ */

async function stats(env) {
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN kind NOT IN ${NOT_TASK} AND status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN kind NOT IN ${NOT_TASK} AND status = 'done'    THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN kind = 'unknown' THEN 1 ELSE 0 END)                                      AS unclassified
     FROM roulette_items`
  ).first();
  return json({ pending: r?.pending ?? 0, done: r?.done ?? 0, unclassified: r?.unclassified ?? 0 });
}

/* ------------------------------------------------------------------ *
 * POST /api/roulette/manual — 수동 등록
 *
 * 도전미션·대결미션 별풍선처럼 위플랩 룰렛이 자동으로 돌지 않아
 * 테스트 트리거로 처리한 건은 후원관리에 안 남습니다.
 * 그런 건들을 직접 넣기 위한 창구입니다.
 *
 * body: { donor_name, donor_id, amount, donated_at, msg, labels: ['🐻역구독', ...] }
 * ------------------------------------------------------------------ */

async function manualAdd(request, env) {
  const b = await request.json().catch(() => ({}));

  const labels = (Array.isArray(b.labels) ? b.labels : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (labels.length === 0) return json({ error: 'no_labels' }, 400);

  const donorId = String(b.donor_id || '').trim();
  const donorName = String(b.donor_name || '').trim() || donorId;
  if (!donorName) return json({ error: 'no_donor' }, 400);

  /* 'YYYY-MM-DD HH:MM' 형태를 기대하지만, 없으면 지금(한국 시간)으로 */
  let at = String(b.donated_at || '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(at)) {
    const now = await env.DB.prepare(`SELECT datetime('now','+9 hours') AS t`).first();
    at = now.t;
  } else if (at.length === 16) {
    at += ':00';
  }

  const idx = 'M' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* 확률은 최근 룰렛표에서 찾아 채웁니다 (없으면 0) */
  const pctRows = await env.DB.prepare(
    `SELECT si.label_key, si.percent
       FROM roulette_set_items si
      WHERE si.set_id IN (SELECT id FROM roulette_sets
                           WHERE revised_at = (SELECT revised_at FROM roulette_sets
                                                ORDER BY id DESC LIMIT 1))`
  ).all();
  const pct = new Map(pctRows.results.map((r) => [r.label_key, r.percent]));

  /* 처음 보는 항목은 메뉴에 등록해 분류 대기로 둡니다 */
  const items = labels.map((label, i) => ({
    seq: i, label, label_key: normKey(label), percent: pct.get(normKey(label)) ?? 0,
  }));

  const uniq = new Map();
  items.forEach((it) => uniq.set(it.label_key, it.label));
  await env.DB.batch(
    [...uniq].map(([k, label]) =>
      env.DB.prepare(
        `INSERT INTO roulette_menu (label_key, label, kind, first_seen, last_seen)
         VALUES (?1, ?2, 'unknown', ?3, ?3)
         ON CONFLICT(label_key) DO UPDATE SET
           last_seen = MAX(COALESCE(roulette_menu.last_seen, ''), excluded.last_seen)`
      ).bind(k, label, at)
    )
  );

  const menuRows = await env.DB.prepare(`SELECT label_key, kind FROM roulette_menu`).all();
  const menu = new Map(menuRows.results.map((x) => [x.label_key, x.kind]));

  const stmts = [
    env.DB.prepare(
      `INSERT INTO roulette_orders
         (idx,no,uid,platform,type,subtype,donor_id,donor_name,amount,msg,donated_at,stream_start,spin_count,synced_at)
       VALUES (?1,NULL,NULL,'afreeca','MANUAL','MANUAL',?2,?3,?4,?5,?6,NULL,?7,datetime('now','+9 hours'))`
    ).bind(idx, donorId || null, donorName, Number(b.amount) || 0,
           String(b.msg || ''), at, items.length),
  ];

  for (const it of items) {
    const kind = menu.get(it.label_key) ?? 'unknown';
    const instant = kind === 'instant';
    const status = statusForKind(kind);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO roulette_items
           (order_idx,seq,label,label_key,percent,kind,status,done_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      ).bind(idx, it.seq, it.label, it.label_key, it.percent, kind, status, instant ? at : null)
    );
  }
  await env.DB.batch(stmts);

  let bonus = 0;
  try { bonus = await applyBonusRules(env, [{ idx, amount: Number(b.amount) || 0, donated_at: at }]); } catch (_) {}

  const unknown = [...uniq.keys()].filter((k) => (menu.get(k) ?? 'unknown') === 'unknown');
  const tasks = items.filter((it) => {
    const k = menu.get(it.label_key) ?? 'unknown';
    return k !== 'instant' && k !== 'meta';
  }).length;

  return json({ ok: true, idx, items: items.length, tasks: tasks + bonus, bonus, unknown });
}

/**
 * 수동으로 넣은 건의 후원자·개수·시각을 고칩니다.
 * 시각을 바꾸면 자동 완료된 즉시형 항목의 처리 시각도 같이 맞춥니다.
 * 위플랩에서 받아온 건은 원본이라 고치지 않습니다.
 */
async function manualUpdate(request, env) {
  const b = await request.json().catch(() => ({}));
  const idx = String(b.idx || '');
  if (!idx) return json({ error: 'bad_request' }, 400);

  const row = await env.DB.prepare(
    `SELECT type, donor_name, donor_id, amount, msg, donated_at
       FROM roulette_orders WHERE idx = ?1`
  ).bind(idx).first();
  if (!row) return json({ error: 'not_found' }, 404);
  if (row.type !== 'MANUAL') return json({ error: 'not_manual' }, 403);

  /* 보내지 않은 항목은 기존 값을 그대로 둡니다 */
  let at = String(b.donated_at ?? '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(at)) at = row.donated_at;
  else if (at.length === 16) at += ':00';

  const name = b.donor_name !== undefined
    ? (String(b.donor_name).trim() || row.donor_name) : row.donor_name;
  const id = b.donor_id !== undefined ? String(b.donor_id).trim() : row.donor_id;
  const amount = b.amount !== undefined ? (Number(b.amount) || 0) : row.amount;
  const msg = b.msg !== undefined ? String(b.msg) : row.msg;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE roulette_orders
          SET donor_name = ?1, donor_id = ?2, amount = ?3, msg = ?4, donated_at = ?5
        WHERE idx = ?6 AND type = 'MANUAL'`
    ).bind(name, id || null, amount, msg, at, idx),
    env.DB.prepare(
      `UPDATE roulette_items SET done_at = ?1
        WHERE order_idx = ?2 AND kind = 'instant' AND status = 'done'`
    ).bind(at, idx),
  ]);

  return json({ ok: true, donated_at: at });
}

/** 수동으로 넣은 건만 지웁니다. 위플랩에서 받아온 건은 건드리지 않습니다. */
async function manualDelete(request, env) {
  const { idx } = await request.json().catch(() => ({}));
  if (!idx) return json({ error: 'bad_request' }, 400);

  const row = await env.DB.prepare(
    `SELECT type FROM roulette_orders WHERE idx = ?1`
  ).bind(String(idx)).first();
  if (!row) return json({ error: 'not_found' }, 404);
  if (row.type !== 'MANUAL') return json({ error: 'not_manual' }, 403);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM roulette_items WHERE order_idx = ?1`).bind(String(idx)),
    env.DB.prepare(`DELETE FROM roulette_orders WHERE idx = ?1`).bind(String(idx)),
  ]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * 요청 받기
 *
 * 프사·방편처럼 시청자가 원하는 내용을 적어야 하는 항목이 있습니다.
 * 그 내용은 남이 보면 안 되므로, 후원자마다 코드를 하나 발급해
 * 코드를 아는 사람만 자기 요청을 쓰고 볼 수 있게 합니다.
 * ------------------------------------------------------------------ */

/** 헷갈리는 글자(0·O·1·I·l)를 뺀 8자리 코드 */
function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => chars[n % chars.length]).join('');
}

/**
 * POST /api/roulette/code — 후원자 코드 발급
 * code 를 보내면 그 값으로, 비워 보내면 자동으로 만듭니다.
 * 이미 있고 force 가 아니면 기존 코드를 그대로 돌려줍니다.
 */
async function issueCode(request, env) {
  const body = await request.json().catch(() => ({}));
  const id = String(body.donor_id || '').trim();
  if (!id) return json({ error: 'no_donor' }, 400);

  const want = String(body.code || '').trim().toUpperCase();

  const cur = await env.DB.prepare(
    `SELECT code FROM roulette_codes WHERE donor_id = ?1`
  ).bind(id).first();

  if (cur && !body.force && !want) return json({ ok: true, code: cur.code, reused: true });

  let code;
  if (want) {
    if (!CODE_RE.test(want)) return json({ error: 'bad_format' }, 400);
    /* 다른 사람이 쓰고 있는 코드는 막습니다 */
    const dup = await env.DB.prepare(
      `SELECT donor_id FROM roulette_codes WHERE code = ?1 AND donor_id <> ?2`
    ).bind(want, id).first();
    if (dup) return json({ error: 'duplicate' }, 409);
    code = want;
  } else {
    code = makeCode();
  }

  await env.DB.prepare(
    `INSERT INTO roulette_codes (donor_id, code, created_at)
     VALUES (?1, ?2, datetime('now','+9 hours'))
     ON CONFLICT(donor_id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at`
  ).bind(id, code).run();

  return json({ ok: true, code, reused: false });
}

/* 자동 발급은 8자, 직접 정하면 4~16자까지 */
const CODE_RE = /^[A-Z0-9]{4,16}$/;

/** 코드로 후원자를 찾습니다. 못 찾으면 null */
async function donorByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

/** GET /api/roulette/my?code=XXXX — 내 요청 목록 */
async function myItems(request, env) {
  const u = new URL(request.url);
  const code = await donorByCode(u.searchParams.get('code'));
  if (!code) return json({ error: 'bad_code' }, 400);

  const owner = await env.DB.prepare(
    `SELECT donor_id FROM roulette_codes WHERE code = ?1`
  ).bind(code).first();
  if (!owner) return json({ error: 'bad_code' }, 404);

  /* 어느 분의 칸에서 열었는지 함께 오면 주인이 맞는지 확인합니다 */
  const asked = String(u.searchParams.get('donor') || '').trim();
  if (asked && asked !== owner.donor_id) return json({ error: 'other_donor' }, 403);

  const rows = await env.DB.prepare(
    `SELECT i.order_idx, i.seq, i.label, i.status, i.request, i.request_at,
            i.request_image, i.request_email, i.reply, i.reply_at,
            o.donated_at, o.donor_name,
            COALESCE(mn.input_label, '') AS input_label
       FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
       LEFT JOIN roulette_menu mn ON mn.label_key = i.label_key
      WHERE o.donor_id = ?1
        AND COALESCE(mn.needs_input, 0) = 1
        AND i.status IN ('pending','scheduled')
      ORDER BY o.donated_at ASC, i.seq ASC`
  ).bind(owner.donor_id).all();

  return json({
    donor_name: rows.results[0]?.donor_name || '',
    items: rows.results.map((r) => ({
      order_idx: r.order_idx,
      seq: r.seq,
      label: r.label,
      status: r.status,
      request: r.request,
      request_at: r.request_at,
      request_image: r.request_image,
      request_email: r.request_email,
      reply: r.reply,
      reply_at: r.reply_at,
      donated_at: r.donated_at,
      input_label: r.input_label,
      /* 이미 처리가 끝났으면 더 고칠 수 없습니다 */
      locked: r.status === 'done',
    })),
  });
}

/** POST /api/roulette/my — 요청 저장 */
async function myWrite(request, env) {
  const b = await request.json().catch(() => ({}));
  const code = await donorByCode(b.code);
  if (!code) return json({ error: 'bad_code' }, 400);

  const owner = await env.DB.prepare(
    `SELECT donor_id FROM roulette_codes WHERE code = ?1`
  ).bind(code).first();
  if (!owner) return json({ error: 'bad_code' }, 404);

  const text = String(b.request || '').slice(0, 1000);
  const email = String(b.request_email || '').trim().slice(0, 200);
  /* 첨부는 우리가 올려준 주소만 받습니다 */
  const image = /^\/api\/img\/[\w./-]+$/.test(String(b.request_image || ''))
    ? String(b.request_image) : '';

  /* 코드 주인의 항목인지, 요청 대상인지, 아직 안 끝났는지 모두 확인합니다 */
  const target = await env.DB.prepare(
    `SELECT i.status
       FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
       LEFT JOIN roulette_menu mn ON mn.label_key = i.label_key
      WHERE i.order_idx = ?1 AND i.seq = ?2
        AND o.donor_id = ?3
        AND COALESCE(mn.needs_input, 0) = 1`
  ).bind(String(b.order_idx || ''), Number(b.seq), owner.donor_id).first();

  if (!target) return json({ error: 'not_found' }, 404);
  if (target.status === 'done') return json({ error: 'locked' }, 409);

  await env.DB.prepare(
    `UPDATE roulette_items
        SET request = ?1, request_email = ?2, request_image = ?3,
            request_at = datetime('now','+9 hours')
      WHERE order_idx = ?4 AND seq = ?5`
  ).bind(text, email, image, String(b.order_idx), Number(b.seq)).run();

  return json({ ok: true });
}

/**
 * POST /api/roulette/my/upload — 시청자 이미지 첨부
 * 코드를 가진 사람만 올릴 수 있고, 이미지만 5MB까지 받습니다.
 */
async function myUpload(request, env) {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: 'bad_request' }, 400);

  const code = await donorByCode(form.get('code'));
  if (!code) return json({ error: 'bad_code' }, 400);

  const owner = await env.DB.prepare(
    `SELECT donor_id FROM roulette_codes WHERE code = ?1`
  ).bind(code).first();
  if (!owner) return json({ error: 'bad_code' }, 404);

  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'no_file' }, 400);

  const type = String(file.type || '');
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(type)) return json({ error: 'bad_type' }, 400);
  if (file.size > 5 * 1024 * 1024) return json({ error: 'too_big' }, 400);

  const ext = type.split('/')[1].replace('jpeg', 'jpg');
  const key = `req/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: type } });

  return json({ ok: true, url: `/api/img/${key}` });
}

/* ------------------------------------------------------------------ *
 * 관리자용
 * ------------------------------------------------------------------ */

async function menuList(env) {
  const r = await env.DB.prepare(
    `SELECT label_key, label, kind, active, first_seen, last_seen,
            COALESCE(needs_input,0) AS needs_input, input_label
       FROM roulette_menu
      ORDER BY (kind = 'unknown') DESC, last_seen DESC`
  ).all();
  return json({ menu: r.results });
}

/**
 * 항목 분류 확정.
 *
 * 기본 동작은 아직 미분류로 남아있는 과거 결과에만 소급 적용합니다.
 * reapply: true 를 보내면 이미 분류된 기록까지 다시 맞추는데,
 * 이때도 "자동으로 처리된 것"만 건드립니다.
 * 비고·다시보기 링크·교체 기록이 있으면 직접 손댄 것으로 보고 그대로 둡니다.
 */
async function menuClassify(request, env) {
  const { label_key, kind, reapply, needs_input, input_label } = await request.json().catch(() => ({}));

  /* 요청 받기 설정만 바꾸는 호출 */
  if (label_key && kind === undefined && needs_input !== undefined) {
    await env.DB.prepare(
      `UPDATE roulette_menu SET needs_input = ?1, input_label = ?2 WHERE label_key = ?3`
    ).bind(needs_input ? 1 : 0, String(input_label || '') || null, label_key).run();
    return json({ ok: true });
  }

  if (!label_key || !['instant', 'task', 'meta', 'coupon'].includes(kind)) return json({ error: 'bad_request' }, 400);

  const statusFor = statusForKind(kind);

  await env.DB.prepare(`UPDATE roulette_menu SET kind = ?1 WHERE label_key = ?2`)
    .bind(kind, label_key).run();

  const backfill = await env.DB.prepare(
    `UPDATE roulette_items
        SET kind    = ?1,
            status  = ?3,
            done_at = CASE WHEN ?1 = 'instant'
                           THEN (SELECT donated_at FROM roulette_orders WHERE idx = order_idx)
                           ELSE NULL END
      WHERE label_key = ?2
        AND kind = 'unknown'
        AND status = 'pending'`
  ).bind(kind, label_key, statusFor).run();

  let moved = backfill.meta?.changes ?? 0;
  let kept = 0;

  if (reapply) {
    const re = await env.DB.prepare(
      `UPDATE roulette_items
          SET kind    = ?1,
              status  = ?3,
              done_at = CASE WHEN ?1 = 'instant'
                             THEN (SELECT donated_at FROM roulette_orders WHERE idx = order_idx)
                             ELSE NULL END
        WHERE label_key = ?2
          AND kind <> ?1
          AND memo IS NULL AND done_ref IS NULL AND resolved_label IS NULL
          AND (   (kind = 'instant' AND status = 'done')
               OR (kind = 'meta'    AND status = 'void')
               OR (kind = 'coupon'  AND status = 'held')
               OR (kind = 'task'    AND status = 'pending') )`
    ).bind(kind, label_key, statusFor).run();
    moved += re.meta?.changes ?? 0;
  }

  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM roulette_items WHERE label_key = ?1 AND kind <> ?2`
  ).bind(label_key, kind).first();
  kept = left?.n ?? 0;

  return json({ ok: true, moved, kept });
}

/* ------------------------------------------------------------------ *
 * 쿠폰 — 교환권을 다른 숙제에 얹어 승급시킵니다
 * ------------------------------------------------------------------ */

/** '일반 B' → '스페셜 B'. 규칙에 안 맞으면 그대로 */
function upgradeLabel(label) {
  const s = String(label || '');
  return /일반/.test(s) ? s.replace('일반', '스페셜') : s;
}

/**
 * POST /api/roulette/coupon/use
 * body: { order_idx, seq, target_order_idx, target_seq, new_label? }
 */
async function couponUse(request, env) {
  const b = await request.json().catch(() => ({}));
  const cKey = [String(b.order_idx || ''), Number(b.seq)];
  const tKey = [String(b.target_order_idx || ''), Number(b.target_seq)];
  if (!cKey[0] || !tKey[0] || Number.isNaN(cKey[1]) || Number.isNaN(tKey[1])) {
    return json({ error: 'bad_request' }, 400);
  }

  const coupon = await env.DB.prepare(
    `SELECT i.kind, i.status, o.donor_id FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
      WHERE i.order_idx = ?1 AND i.seq = ?2`
  ).bind(...cKey).first();
  if (!coupon || coupon.kind !== 'coupon') return json({ error: 'not_coupon' }, 400);
  if (coupon.status !== 'held') return json({ error: 'already_used' }, 409);

  const target = await env.DB.prepare(
    `SELECT i.label, i.status, i.kind, i.resolved_label, o.donor_id FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
      WHERE i.order_idx = ?1 AND i.seq = ?2`
  ).bind(...tKey).first();
  if (!target) return json({ error: 'no_target' }, 404);
  /* 같은 후원자의 숙제에만 쓸 수 있습니다 */
  if (target.donor_id !== coupon.donor_id) return json({ error: 'other_donor' }, 403);
  if (target.kind !== 'task' && target.kind !== 'unknown') return json({ error: 'bad_target' }, 400);

  const newLabel = String(b.new_label || '').trim() || upgradeLabel(target.resolved_label || target.label);
  const usedFor = `${tKey[0]}::${tKey[1]}`;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE roulette_items
          SET status = 'used', used_for = ?3, done_at = datetime('now','+9 hours')
        WHERE order_idx = ?1 AND seq = ?2`
    ).bind(cKey[0], cKey[1], usedFor),
    env.DB.prepare(
      `UPDATE roulette_items SET resolved_label = ?3
        WHERE order_idx = ?1 AND seq = ?2`
    ).bind(tKey[0], tKey[1], newLabel),
  ]);

  return json({ ok: true, new_label: newLabel });
}

/** POST /api/roulette/coupon/undo — body: { order_idx, seq } (쿠폰 쪽) */
async function couponUndo(request, env) {
  const b = await request.json().catch(() => ({}));
  const cKey = [String(b.order_idx || ''), Number(b.seq)];
  const coupon = await env.DB.prepare(
    `SELECT status, used_for FROM roulette_items WHERE order_idx = ?1 AND seq = ?2 AND kind = 'coupon'`
  ).bind(...cKey).first();
  if (!coupon) return json({ error: 'not_found' }, 404);
  if (coupon.status !== 'used' || !coupon.used_for) return json({ error: 'not_used' }, 409);

  const [tIdx, tSeq] = coupon.used_for.split('::');
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE roulette_items SET status = 'held', used_for = NULL, done_at = NULL
        WHERE order_idx = ?1 AND seq = ?2`
    ).bind(...cKey),
    /* 승급 표시만 걷어냅니다. 직접 적은 교체 항목이면 건드리지 않도록 '스페셜' 로 바뀐 경우만 */
    env.DB.prepare(
      `UPDATE roulette_items SET resolved_label = NULL
        WHERE order_idx = ?1 AND seq = ?2 AND resolved_label LIKE '%스페셜%'`
    ).bind(tIdx, Number(tSeq)),
  ]);

  return json({ ok: true });
}

/** 숙제 처리 상태 변경 (일괄 지원) */
async function itemStatus(request, env) {
  const { targets, status, done_ref, memo, resolved_label, image_url, reply } =
    await request.json().catch(() => ({}));
  if (!Array.isArray(targets) || targets.length === 0) return json({ error: 'bad_request' }, 400);
  if (!['pending', 'scheduled', 'done', 'void'].includes(status)) return json({ error: 'bad_status' }, 400);

  // 보내지 않은 필드는 그대로 두고, 빈 문자열을 보내면 지웁니다.
  const keep = (v) => (v === undefined ? null : v);

  await env.DB.batch(
    targets.map((t) =>
      env.DB.prepare(
        `UPDATE roulette_items
            SET status         = ?1,
                done_at        = CASE WHEN ?1 = 'done'
                                      THEN COALESCE(done_at, datetime('now', '+9 hours'))
                                      ELSE NULL END,
                done_ref       = COALESCE(?2, done_ref),
                memo           = COALESCE(?3, memo),
                resolved_label = COALESCE(?4, resolved_label),
                image_url      = COALESCE(?5, image_url),
                reply          = COALESCE(?6, reply),
                reply_at       = CASE WHEN ?6 IS NULL THEN reply_at
                                      ELSE datetime('now','+9 hours') END
          WHERE order_idx = ?7 AND seq = ?8`
      ).bind(
        status,
        keep(done_ref),
        keep(t.memo ?? memo),
        keep(t.resolved_label ?? resolved_label),
        keep(t.image_url ?? image_url),
        keep(t.reply ?? reply),
        String(t.order_idx),
        Number(t.seq)
      )
    )
  );

  return json({ ok: true, updated: targets.length });
}