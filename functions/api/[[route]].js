/* ═══════════════════════════════════════════════════════════
   API — Cloudflare Pages Functions
   /api/* 요청을 처리합니다.

   필요한 바인딩 (Pages > Settings > Bindings):
     DB     → D1 데이터베이스
     BUCKET → R2 버킷
   필요한 환경변수 (Pages > Settings > Variables):
     ADMIN_TOKEN → 관리자 비밀 문자열 (직접 정해서 입력)
   ═══════════════════════════════════════════════════════════ */

const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8' };

const ok   = (data)        => new Response(JSON.stringify(data), { headers: JSON_HEAD });
const fail = (msg, status) => new Response(JSON.stringify({ error: msg }), { status: status || 400, headers: JSON_HEAD });

/* 관리자 확인 */
function isAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token');
  return !!(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const parts  = params.route || [];
  const seg    = parts[0] || '';
  const id     = parts[1] || '';
  const method = request.method;

  try {
    /* ───── 이미지 제공: GET /api/img/<key> ───── */
    if (seg === 'img') {
      const key = parts.slice(1).join('/');
      if (!key) return fail('no key', 404);
      const obj = await env.BUCKET.get(key);
      if (!obj) return fail('not found', 404);
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('etag', obj.httpEtag);
      h.set('Cache-Control', 'public, max-age=31536000');
      return new Response(obj.body, { headers: h });
    }

    /* ───── 이미지 업로드: POST /api/upload (관리자) ───── */
    if (seg === 'upload' && method === 'POST') {
      if (!isAdmin(request, env)) return fail('unauthorized', 401);
      const form = await request.formData();
      const file = form.get('file');
      if (!file) return fail('no file');
      const ext  = (file.name || '').split('.').pop().toLowerCase() || 'png';
      const key  = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await env.BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'image/png' }
      });
      return ok({ url: `/api/img/${key}`, key });
    }

    /* ───── 이미지 삭제: DELETE /api/upload/<key> (관리자) ───── */
    if (seg === 'upload' && method === 'DELETE') {
      if (!isAdmin(request, env)) return fail('unauthorized', 401);
      await env.BUCKET.delete(parts.slice(1).join('/'));
      return ok({ deleted: true });
    }

    /* ───── 방송 ───── */
    if (seg === 'broadcasts') {
      if (method === 'GET') {
        try {
          const { results } = await env.DB
            .prepare('SELECT * FROM broadcasts ORDER BY sort_order ASC, created_at DESC')
            .all();
          return ok(results || []);
        } catch (_) {           /* sort_order 컬럼이 아직 없는 경우 */
          const { results } = await env.DB
            .prepare('SELECT * FROM broadcasts ORDER BY created_at DESC')
            .all();
          return ok(results || []);
        }
      }
      if (method === 'POST') {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        const b = await request.json();
        try {
          await env.DB.prepare(
            `INSERT INTO broadcasts (title, broadcast_date, tags, youtube_url, soop_url, thumbnail_url, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(b.title || '', b.broadcast_date || '', b.tags || '',
                 b.youtube_url || '', b.soop_url || '', b.thumbnail_url || '', b.sort_order || 0).run();
        } catch (_) {
          await env.DB.prepare(
            `INSERT INTO broadcasts (title, broadcast_date, tags, youtube_url, soop_url, thumbnail_url)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(b.title || '', b.broadcast_date || '', b.tags || '',
                 b.youtube_url || '', b.soop_url || '', b.thumbnail_url || '').run();
        }
        return ok({ saved: true });
      }
      if (method === 'PUT' && id) {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        const b = await request.json();
        await env.DB.prepare(
          `UPDATE broadcasts SET title=?, broadcast_date=?, tags=?,
           youtube_url=?, soop_url=?, thumbnail_url=?, sort_order=? WHERE id=?`
        ).bind(b.title || '', b.broadcast_date || '', b.tags || '',
               b.youtube_url || '', b.soop_url || '', b.thumbnail_url || '', b.sort_order || 0, id).run();
        return ok({ updated: true });
      }
      if (method === 'DELETE' && id) {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        await env.DB.prepare('DELETE FROM broadcasts WHERE id=?').bind(id).run();
        return ok({ deleted: true });
      }
    }

    /* ───── 화보 ───── */
    if (seg === 'gallery') {
      if (method === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT * FROM gallery ORDER BY sort_order ASC, created_at DESC')
          .all();
        return ok(results || []);
      }
      if (method === 'POST') {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        const g = await request.json();
        await env.DB.prepare(
          `INSERT INTO gallery (title, description, image_url, sort_order)
           VALUES (?, ?, ?, ?)`
        ).bind(g.title || '', g.description || '', g.image_url || '', g.sort_order || 0).run();
        return ok({ saved: true });
      }
      if (method === 'PUT' && id) {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        const g = await request.json();
        await env.DB.prepare(
          'UPDATE gallery SET title=?, description=?, image_url=?, sort_order=? WHERE id=?'
        ).bind(g.title || '', g.description || '', g.image_url || '', g.sort_order || 0, id).run();
        return ok({ updated: true });
      }
      if (method === 'DELETE' && id) {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        await env.DB.prepare('DELETE FROM gallery WHERE id=?').bind(id).run();
        return ok({ deleted: true });
      }
    }

    /* ───── 문의 ───── */
    if (seg === 'inquiries') {
      if (method === 'POST') {                    /* 누구나 남길 수 있음 */
        const q = await request.json();
        if (!q.nickname || !q.message) return fail('missing fields');
        await env.DB.prepare(
          'INSERT INTO inquiries (nickname, contact, message) VALUES (?, ?, ?)'
        ).bind(String(q.nickname).slice(0, 100),
               String(q.contact || '').slice(0, 200),
               String(q.message).slice(0, 5000)).run();
        return ok({ saved: true });
      }
      if (method === 'GET') {                     /* 조회는 관리자만 */
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        try {
          const { results } = await env.DB
            .prepare('SELECT * FROM inquiries ORDER BY done ASC, created_at DESC')
            .all();
          return ok(results || []);
        } catch (_) {           /* done 컬럼이 아직 없는 경우 */
          const { results } = await env.DB
            .prepare('SELECT * FROM inquiries ORDER BY created_at DESC')
            .all();
          return ok(results || []);
        }
      }
      if (method === 'PUT' && id) {                /* 처리 여부 변경 */
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        const q = await request.json();
        try {
          await env.DB.prepare('UPDATE inquiries SET done=? WHERE id=?')
            .bind(q.done ? 1 : 0, id).run();
        } catch (_) {
          return fail("done 컬럼이 없습니다. D1에서 다음을 실행하세요: ALTER TABLE inquiries ADD COLUMN done INTEGER DEFAULT 0;", 409);
        }
        return ok({ updated: true });
      }
      if (method === 'DELETE' && id) {
        if (!isAdmin(request, env)) return fail('unauthorized', 401);
        await env.DB.prepare('DELETE FROM inquiries WHERE id=?').bind(id).run();
        return ok({ deleted: true });
      }
    }

    /* ───── 링크 미리보기 이미지 가져오기: GET /api/ogimage?url=... ───── */
    if (seg === 'ogimage' && method === 'GET') {
      if (!isAdmin(request, env)) return fail('unauthorized', 401);
      const target = new URL(request.url).searchParams.get('url');
      if (!target) return fail('no url');
      try {
        const r = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
          },
          redirect: 'follow'
        });
        if (!r.ok) return fail('페이지를 열지 못했어요 (HTTP ' + r.status + ')', 502);
        const html = await r.text();

        /* meta 태그를 속성 순서와 무관하게 찾습니다 */
        const findMeta = (names) => {
          const tags = html.match(/<meta\s[^>]*>/gi) || [];
          for (const tag of tags) {
            const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
            if (!key || names.indexOf(key.toLowerCase()) < 0) continue;
            const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
            if (val) return val;
          }
          return '';
        };

        let img = findMeta(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
        if (!img) {
          const m = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
          if (m) img = m[1];
        }
        if (!img) return fail('이 페이지에서 썸네일을 찾지 못했어요', 404);

        /* HTML 엔티티 복원 + 상대경로 보정 */
        img = img.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').trim();
        if (img.startsWith('//')) img = 'https:' + img;
        else if (img.startsWith('/')) img = new URL(target).origin + img;

        return ok({ image: img });
      } catch (e) {
        return fail('가져오기 실패: ' + (e.message || 'unknown'), 502);
      }
    }

    /* ───── 관리자 토큰 확인 (로그인용) ───── */
    if (seg === 'auth' && method === 'POST') {
      return isAdmin(request, env) ? ok({ ok: true }) : fail('unauthorized', 401);
    }

    return fail('not found', 404);

  } catch (e) {
    return fail(e.message || 'server error', 500);
  }
}