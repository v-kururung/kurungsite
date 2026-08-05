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

/** 위플랩 alertlist 레코드 → 우리 구조. 룰렛 결과가 없으면 null */
export function parseRecord(r) {
  let list;
  try {
    list = JSON.parse(r.list || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!r.idx) return null;

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
    if (sub === 'sets' && !sub2 && m === 'GET') return json(await currentSets(env));

    if (sub === 'sets' && sub2 === 'sync' && m === 'POST') {
      if (!admin) return denied();
      const force = new URL(request.url).searchParams.get('force') === '1';
      return json(await syncRouletteSets(env, { force }));
    }

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
  const limit = Math.min(Number(u.searchParams.get('limit')) || 10, 50);
  const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);

  const itemCond = [];
  const itemArgs = [];
  if (scope === 'task') itemCond.push(`i.kind NOT IN ('instant','meta')`);
  if (status) { itemCond.push(`i.status = ?`); itemArgs.push(status); }
  const itemWhere = itemCond.length ? ` AND ${itemCond.join(' AND ')}` : '';

  const searchWhere = q ? ` AND (o.donor_name LIKE ? OR o.donor_id LIKE ?)` : '';
  const searchArgs = q ? [`%${q}%`, `%${q}%`] : [];

  const ordersQ = await env.DB.prepare(
    `SELECT o.* FROM roulette_orders o
      WHERE EXISTS (SELECT 1 FROM roulette_items i WHERE i.order_idx = o.idx${itemWhere})
      ${searchWhere}
      ORDER BY o.donated_at DESC
      LIMIT ? OFFSET ?`
  ).bind(...itemArgs, ...searchArgs, limit, offset).all();

  const rows = ordersQ.results;
  if (rows.length === 0) return json({ orders: [], hasMore: false });

  const ids = rows.map((r) => r.idx);
  const itemsQ = await env.DB.prepare(
    `SELECT order_idx, seq, label, percent, kind, status, done_at, done_ref, memo, resolved_label
       FROM roulette_items
      WHERE order_idx IN (${ids.map(() => '?').join(',')})${itemWhere.replace(/\bi\./g, '')}
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
      items: grouped.get(o.idx) || [],
    })),
    hasMore: rows.length === limit,
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
 * 관리자용
 * ------------------------------------------------------------------ */

async function menuList(env) {
  const r = await env.DB.prepare(
    `SELECT label_key, label, kind, active, first_seen, last_seen
       FROM roulette_menu
      ORDER BY (kind = 'unknown') DESC, last_seen DESC`
  ).all();
  return json({ menu: r.results });
}

/** 항목 분류 확정 + 아직 미분류로 남아있는 과거 결과에 소급 적용 */
async function menuClassify(request, env) {
  const { label_key, kind } = await request.json().catch(() => ({}));
  if (!label_key || !['instant', 'task', 'meta'].includes(kind)) return json({ error: 'bad_request' }, 400);

  // instant = 방송 중 즉시 처리 → 바로 완료
  // meta    = 다음 룰렛 2배처럼 해줄 일이 없는 항목 → 처리 대상에서 제외
  // task    = 나중에 해줘야 하는 숙제 → 대기
  const statusFor = { instant: 'done', meta: 'void', task: 'pending' }[kind];

  await env.DB.batch([
    env.DB.prepare(`UPDATE roulette_menu SET kind = ?1 WHERE label_key = ?2`).bind(kind, label_key),
    env.DB.prepare(
      `UPDATE roulette_items
          SET kind    = ?1,
              status  = ?3,
              done_at = CASE WHEN ?1 = 'instant'
                             THEN (SELECT donated_at FROM roulette_orders WHERE idx = order_idx)
                             ELSE NULL END
        WHERE label_key = ?2
          AND kind = 'unknown'
          AND status = 'pending'`
    ).bind(kind, label_key, statusFor),
  ]);

  return json({ ok: true });
}

/** 숙제 처리 상태 변경 (일괄 지원) */
async function itemStatus(request, env) {
  const { targets, status, done_ref, memo, resolved_label } = await request.json().catch(() => ({}));
  if (!Array.isArray(targets) || targets.length === 0) return json({ error: 'bad_request' }, 400);
  if (!['pending', 'scheduled', 'done', 'void'].includes(status)) return json({ error: 'bad_status' }, 400);

  // 보내지 않은 필드는 그대로 두고, 빈 문자열을 보내면 지웁니다.
  const keep = (v) => (v === undefined ? null : v);

  await env.DB.batch(
    targets.map((t) =>
      env.DB.prepare(
        `UPDATE roulette_items
            SET status         = ?1,
                done_at        = CASE WHEN ?1 = 'done' THEN COALESCE(done_at, datetime('now')) ELSE NULL END,
                done_ref       = COALESCE(?2, done_ref),
                memo           = COALESCE(?3, memo),
                resolved_label = COALESCE(?4, resolved_label)
          WHERE order_idx = ?5 AND seq = ?6`
      ).bind(
        status,
        keep(done_ref),
        keep(t.memo ?? memo),
        keep(t.resolved_label ?? resolved_label),
        String(t.order_idx),
        Number(t.seq)
      )
    )
  );

  return json({ ok: true, updated: targets.length });
}