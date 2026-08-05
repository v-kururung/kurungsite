/**
 * 위플랩 공개 룰렛 확률표 동기화
 *
 * https://weflab.com/user/<공개키> 는 로그인 없이 열리고 값이 서버에서 렌더링되므로
 * Worker가 직접 fetch해서 파싱할 수 있습니다. 확장이 필요 없습니다.
 *
 * 필요한 것
 *   - env.DB
 *   - env.ROULETTE_PUBLIC_KEY : 예) lOPU2suSlGdvZms
 *
 * wrangler.toml 에 크론을 걸어두면 룰렛을 바꿔도 알아서 따라옵니다.
 *   [triggers]
 *   crons = ["0 3 * * *"]   # 매일 KST 12시
 *
 * 그리고 Worker의 scheduled 핸들러에서:
 *   export default {
 *     async fetch(request, env) { ... },
 *     async scheduled(event, env, ctx) {
 *       ctx.waitUntil(syncRouletteSets(env));
 *     }
 *   };
 */

const PAGE_BASE = 'https://weflab.com/user/';

/** roulette.js와 같은 규칙 — 이모지를 떼어 메뉴 매칭 키를 만듭니다. */
const normKey = (s) =>
  String(s)
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/* ------------------------------------------------------------------ *
 * 파싱
 * ------------------------------------------------------------------ */

/** "2026년 08월 02일 14시 58분 18초" → "2026-08-02 14:58:18" */
function parseRevisedAt(html) {
  const m = html.match(/마지막 수정시간은[\s\S]{0,120}?<b[^>]*>([^<]+)<\/b>/);
  if (!m) return null;
  const n = m[1].match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!n) return null;
  const p = (v) => String(v).padStart(2, '0');
  return `${n[1]}-${p(n[2])}-${p(n[3])} ${p(n[4])}:${p(n[5])}:${p(n[6])}`;
}

const decode = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * 공개 페이지 HTML → 세트 배열
 * [{ unit: 33, spins: 1, items: [{ seq, label, label_key, percent }] }, ...]
 */
export function parseRoulettePage(html) {
  const revised_at = parseRevisedAt(html);

  // 후원 개수 세트마다 alert_box 하나
  const blocks = html.split(/<div class="alert_box[^"]*"/).slice(1);

  const sets = blocks.map((block) => {
    const unit = Number(block.match(/class=['"]value min['"]>\s*([\d,]+)\s*</)?.[1]?.replace(/,/g, '') || 0);

    // 연차 블록은 330개처럼 설정된 세트에만 있습니다. 없으면 1회.
    const spins = Number(block.match(/연차[\s\S]{0,300}?<p>\s*(\d+)\s*회\s*<\/p>/)?.[1] || 1);

    const names = [...block.matchAll(/value="([^"]*)"\s+class="input_text input_roulette_name"/g)].map((m) => decode(m[1]));
    const pcts = [...block.matchAll(/value="([^"]*)"\s+class="input_text decimal right input_roulette_percent"/g)].map((m) => Number(m[1]) || 0);

    const items = names.map((label, i) => ({
      seq: i,
      label,
      label_key: normKey(label),
      percent: pcts[i] ?? 0,
    }));

    return { unit, spins, items };
  }).filter((s) => s.unit > 0 && s.items.length > 0);

  return { revised_at, sets };
}

/* ------------------------------------------------------------------ *
 * 저장
 * ------------------------------------------------------------------ */

export async function syncRouletteSets(env, opts = {}) {
  const key = opts.publicKey || env.ROULETTE_PUBLIC_KEY;
  if (!key) throw new Error('ROULETTE_PUBLIC_KEY가 없습니다.');

  const res = await fetch(PAGE_BASE + key, {
    headers: { 'User-Agent': 'kurung-site-sync/1.0' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`위플랩 페이지 응답 ${res.status}`);

  const { revised_at, sets } = parseRoulettePage(await res.text());
  if (!revised_at || sets.length === 0) throw new Error('페이지 구조가 바뀐 것 같습니다. 파싱 실패.');

  // 확률 합이 100%에서 크게 벗어나면 파싱이 어긋난 것으로 봅니다.
  const warnings = sets
    .map((s) => ({ unit: s.unit, sum: s.items.reduce((a, i) => a + i.percent, 0) }))
    .filter((s) => Math.abs(s.sum - 100) > 0.01);

  // 같은 수정시간이면 이미 저장된 세트
  const latest = await env.DB.prepare(
    `SELECT revised_at FROM roulette_sets ORDER BY id DESC LIMIT 1`
  ).first();
  if (!opts.force && latest?.revised_at === revised_at) {
    return { changed: false, revised_at, sets: sets.length, warnings };
  }

  const stored = [];
  for (const s of sets) {
    const ins = await env.DB.prepare(
      `INSERT INTO roulette_sets (revised_at, unit, spins, captured_at)
       VALUES (?1, ?2, ?3, datetime('now'))`
    ).bind(revised_at, s.unit, s.spins).run();

    const setId = ins.meta.last_row_id;
    await env.DB.batch(
      s.items.map((it) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO roulette_set_items (set_id, seq, label, label_key, percent)
           VALUES (?1, ?2, ?3, ?4, ?5)`
        ).bind(setId, it.seq, it.label, it.label_key, it.percent)
      )
    );
    stored.push({ setId, unit: s.unit, spins: s.spins, items: s.items.length });
  }

  // 새 룰렛 항목을 미리 메뉴에 등록해둡니다.
  // 당첨이 나오기 전에 분류할 수 있으므로 첫 후원부터 정확히 잡힙니다.
  const uniq = new Map();
  for (const s of sets) for (const it of s.items) uniq.set(it.label_key, it.label);

  await env.DB.batch(
    [...uniq].map(([label_key, label]) =>
      env.DB.prepare(
        `INSERT INTO roulette_menu (label_key, label, kind, first_seen, last_seen)
         VALUES (?1, ?2, 'unknown', ?3, ?3)
         ON CONFLICT(label_key) DO UPDATE SET
           label = excluded.label,
           last_seen = MAX(COALESCE(roulette_menu.last_seen, ''), excluded.last_seen)`
      ).bind(label_key, label, revised_at)
    )
  );

  const unknown = await env.DB.prepare(
    `SELECT label FROM roulette_menu WHERE kind = 'unknown' ORDER BY last_seen DESC`
  ).all();

  return {
    changed: true,
    revised_at,
    sets: stored,
    unclassified: unknown.results.map((r) => r.label),
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 조회 — 주문내역 페이지에 현재 확률표를 그대로 띄울 때 씁니다.
 * ------------------------------------------------------------------ */

export async function currentSets(env) {
  const head = await env.DB.prepare(
    `SELECT revised_at FROM roulette_sets ORDER BY id DESC LIMIT 1`
  ).first();
  if (!head) return { revised_at: null, sets: [] };

  const setsQ = await env.DB.prepare(
    `SELECT id, unit, spins FROM roulette_sets WHERE revised_at = ?1 ORDER BY unit`
  ).bind(head.revised_at).all();

  const ids = setsQ.results.map((s) => s.id);
  if (ids.length === 0) return { revised_at: head.revised_at, sets: [] };

  const itemsQ = await env.DB.prepare(
    `SELECT si.set_id, si.seq, si.label, si.percent, COALESCE(m.kind, 'unknown') AS kind
       FROM roulette_set_items si
       LEFT JOIN roulette_menu m ON m.label_key = si.label_key
      WHERE si.set_id IN (${ids.map(() => '?').join(',')})
      ORDER BY si.set_id, si.seq`
  ).bind(...ids).all();

  const grouped = new Map(ids.map((id) => [id, []]));
  itemsQ.results.forEach((it) => grouped.get(it.set_id)?.push(it));

  return {
    revised_at: head.revised_at,
    sets: setsQ.results.map((s) => ({
      unit: s.unit,
      spins: s.spins,
      items: grouped.get(s.id) || [],
    })),
  };
}