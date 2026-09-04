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
    if (sub === 'my' && m === 'POST') return await myWrite(request, env);
    if (sub === 'code' && m === 'POST') return admin ? await issueCode(request, env) : denied();

    if (sub === 'menu' && m === 'GET') return admin ? await menuList(env) : denied();
    if (sub === 'menu' && m === 'POST') return admin ? await menuClassify(request, env) : denied();
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
      const status = instant ? 'done' : kind === 'meta' ? 'void' : 'pending';
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
        if (kind !== 'instant' && kind !== 'meta') newTasks++;
      }
    });
    cursor += part.length;
  }

  const unknown = [...seen.keys()].filter((k) => (menu.get(k) ?? 'unknown') === 'unknown');
  const newOrders = orders.filter((o) => !known.has(o.idx)).length;
  const latest = orders.reduce((a, o) => (o.donated_at > a ? o.donated_at : a), '');

  /* 5) 확률표도 하루 한 번 정도 같이 확인합니다.
        Pages Functions에는 크론이 없어서 동기화에 얹었습니다. 실패해도 무시합니다. */
  let sets = null;
  try {
    sets = await maybeSyncSets(env);
  } catch (_) {}

  return json({ ok: true, received: records.length, newOrders, newItems, newTasks, unknown, latest, sets });
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
 * ?scope=task|all  ?status=pending|done  ?q=닉네임  ?limit=&offset=
 * ------------------------------------------------------------------ */

async function list(request, env, admin) {
  const u = new URL(request.url);
  const scope = u.searchParams.get('scope') === 'all' ? 'all' : 'task';
  const status = u.searchParams.get('status') || '';
  const q = (u.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(u.searchParams.get('limit')) || 10, 200);
  const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
  /* 관리자는 오래된 순(먼저 받은 숙제부터), 방문자 화면은 최신순이 자연스럽습니다 */
  const dir = u.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';

  /* 주문을 고를 때 쓰는 조건 — 상태 필터를 포함합니다 */
  const itemCond = [];
  const itemArgs = [];
  if (scope === 'task') itemCond.push(`i.kind NOT IN ('instant','meta')`);
  if (status) { itemCond.push(`i.status = ?`); itemArgs.push(status); }
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
  if (status) { searchItemCond.push(`s.status = ?`); searchItemArgs.push(status); }
  const searchItemWhere = searchItemCond.length ? ` AND ${searchItemCond.join(' AND ')}` : '';

  const searchWhere = q
    ? ` AND (o.donor_name LIKE ? OR o.donor_id LIKE ? OR o.msg LIKE ?
             OR EXISTS (SELECT 1 FROM roulette_items s
                         WHERE s.order_idx = o.idx${searchItemWhere}
                           AND (s.label LIKE ? OR s.memo LIKE ? OR s.resolved_label LIKE ?)))`
    : '';
  const searchArgs = q
    ? [`%${q}%`, `%${q}%`, `%${q}%`, ...searchItemArgs, `%${q}%`, `%${q}%`, `%${q}%`]
    : [];

  const ordersQ = await env.DB.prepare(
    `SELECT o.*,
       (SELECT COUNT(*) FROM roulette_items t
         WHERE t.order_idx = o.idx AND t.kind NOT IN ('instant','meta')) AS task_total,
       (SELECT COUNT(*) FROM roulette_items t
         WHERE t.order_idx = o.idx AND t.kind NOT IN ('instant','meta') AND t.status = 'done') AS task_done,
       (SELECT c.code FROM roulette_codes c WHERE c.donor_id = o.donor_id) AS code
       FROM roulette_orders o
      WHERE EXISTS (SELECT 1 FROM roulette_items i WHERE i.order_idx = o.idx${itemWhere})
      ${searchWhere}
      ORDER BY o.donated_at ${dir}
      LIMIT ? OFFSET ?`
  ).bind(...itemArgs, ...searchArgs, limit, offset).all();

  const rows = ordersQ.results;
  if (rows.length === 0) return json({ orders: [], hasMore: false });

  const ids = rows.map((r) => r.idx);
  const itemsQ = await env.DB.prepare(
    `SELECT order_idx, seq, label, percent, kind, status, done_at, done_ref, memo,
            resolved_label, image_url, request, request_at
       FROM roulette_items
      WHERE order_idx IN (${ids.map(() => '?').join(',')})${showWhere}
      ORDER BY seq`
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

  const where = q ? `AND (o.donor_name LIKE ?1 OR o.donor_id LIKE ?1)` : '';
  const args = q ? [`%${q}%`] : [];

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
     HAVING pending > 0 OR done > 0
      ORDER BY ${newest
        ? 'last_donated DESC'
        : '(oldest_pending IS NULL), oldest_pending ASC, pending DESC, last_donated DESC'}`
  ).bind(...args).all();

  const list = rows.results;
  if (list.length === 0) return json({ donors: [] });

  /* 대기·완료 항목을 함께 받아 각 후원자에 붙입니다.
     done_ref(게시글 주소)·image_url(작업 스크린샷)·request(본인만 보는 요청)는
     공개 화면에 나가면 안 되므로 아예 조회하지 않습니다. */
  const ids = list.map((d) => d.donor_id);
  const items = await env.DB.prepare(
    `SELECT o.donor_id, o.donated_at, i.order_idx, i.seq, i.status, i.label,
            i.memo, i.resolved_label, i.done_at,
            COALESCE(mn.needs_input, 0) AS needs_input
       FROM roulette_items i
       JOIN roulette_orders o ON o.idx = i.order_idx
       LEFT JOIN roulette_menu mn ON mn.label_key = i.label_key
      WHERE i.status IN ('pending','done')
        AND i.kind NOT IN ('instant','meta')
        AND o.donor_id IN (${ids.map(() => '?').join(',')})
      ORDER BY o.donated_at ASC, i.seq ASC`
  ).bind(...ids).all();

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
    })),
  });
}

/* ------------------------------------------------------------------ *
 * GET /api/roulette/stats
 * ------------------------------------------------------------------ */

async function stats(env) {
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN kind NOT IN ('instant','meta') AND status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN kind NOT IN ('instant','meta') AND status = 'done'    THEN 1 ELSE 0 END) AS done,
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
    const status = instant ? 'done' : kind === 'meta' ? 'void' : 'pending';
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO roulette_items
           (order_idx,seq,label,label_key,percent,kind,status,done_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      ).bind(idx, it.seq, it.label, it.label_key, it.percent, kind, status, instant ? at : null)
    );
  }
  await env.DB.batch(stmts);

  const unknown = [...uniq.keys()].filter((k) => (menu.get(k) ?? 'unknown') === 'unknown');
  const tasks = items.filter((it) => {
    const k = menu.get(it.label_key) ?? 'unknown';
    return k !== 'instant' && k !== 'meta';
  }).length;

  return json({ ok: true, idx, items: items.length, tasks, unknown });
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
        SET request = ?1, request_at = datetime('now','+9 hours')
      WHERE order_idx = ?2 AND seq = ?3`
  ).bind(text, String(b.order_idx), Number(b.seq)).run();

  return json({ ok: true });
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

  if (!label_key || !['instant', 'task', 'meta'].includes(kind)) return json({ error: 'bad_request' }, 400);

  // instant = 방송 중 즉시 처리 → 바로 완료
  // meta    = 다음 룰렛 2배처럼 해줄 일이 없는 항목 → 처리 대상에서 제외
  // task    = 나중에 해줘야 하는 숙제 → 대기
  const statusFor = { instant: 'done', meta: 'void', task: 'pending' }[kind];

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

/** 숙제 처리 상태 변경 (일괄 지원) */
async function itemStatus(request, env) {
  const { targets, status, done_ref, memo, resolved_label, image_url } = await request.json().catch(() => ({}));
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
                image_url      = COALESCE(?5, image_url)
          WHERE order_idx = ?6 AND seq = ?7`
      ).bind(
        status,
        keep(done_ref),
        keep(t.memo ?? memo),
        keep(t.resolved_label ?? resolved_label),
        keep(t.image_url ?? image_url),
        String(t.order_idx),
        Number(t.seq)
      )
    )
  );

  return json({ ok: true, updated: targets.length });
}