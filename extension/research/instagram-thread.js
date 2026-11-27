// Serialized into the exact Instagram tab for the duration of one read.
export function observeInstagramThread(action, run, mediaId, limit, shortcode, expected) {
  const key = '__seedingSysInstagramThread';
  const existing = window[key];
  if (action === 'finish') {
    if (existing?.run !== run) return [];
    existing.close();
    return existing.comments;
  }
  if (!/^\d{8,32}$/.test(mediaId ?? '') || !Number.isInteger(limit) || limit < 1) return false;
  if (action === 'start') existing?.close();
  const comments = [], seen = new Set();
  const replyCounts = new Map(), advertisedReplies = new Map();
  const inlineCursors = new Map(), withoutText = new Set();
  const state = { run, comments, open: true, close: () => {} };
  let roots = 0;
  const collect = (value, parent = null, depth = 0) => {
    if (!state.open || !value || typeof value !== 'object' || depth > 24 || comments.length >= 40) return;
    const id = value.pk ?? value.id;
    const name = value.user?.username ?? value.owner?.username;
    if (/^\d{8,32}$/.test(String(id ?? '')) && typeof name === 'string' && !String(value.text ?? '').trim()) {
      withoutText.add(String(id));
    }
    if (/^\d{8,32}$/.test(String(id ?? '')) && typeof name === 'string' && /^[\w.]{1,30}$/.test(name)
      && typeof value.text === 'string' && value.text.trim() && value.text.length <= 8_000) {
      const externalId = String(id);
      if (!seen.has(externalId) && (parent || roots < limit)) {
        seen.add(externalId);
        if (!parent) roots++;
        else replyCounts.set(parent, (replyCounts.get(parent) ?? 0) + 1);
        comments.push({ externalId, parentExternalId: parent, name, text: value.text.trim(), depth: parent ? 1 : 0 });
      }
      if (seen.has(externalId)) {
        const replyCount = value.child_comment_count ?? value.edge_threaded_comments?.count;
        if (!parent && Number.isSafeInteger(replyCount) && replyCount > 0) {
          advertisedReplies.set(externalId, Math.max(advertisedReplies.get(externalId) ?? 0, replyCount));
          if (typeof value.next_max_child_cursor === 'string' && value.next_max_child_cursor) {
            inlineCursors.set(externalId, value.next_max_child_cursor);
          }
        }
        for (const children of [value.child_comments, value.preview_child_comments, value.edge_threaded_comments, value.replies]) {
          if (children) collect(children, externalId, depth + 1);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry, parent, depth + 1);
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      if (/^(?:data|node|edges|items|comments|preview_comments|xdt_.+comments.*|edge_media_to_.+comment.*)$/i.test(field)) {
        collect(child, parent, depth + 1);
      }
    }
  };
  const deadline = Date.now() + 25_000;
  const matches = (raw, body) => {
    if (!state.open || Date.now() > deadline) return false;
    try {
      const url = new URL(typeof raw === 'string' ? raw : raw?.url ?? String(raw), location.href);
      if (url.origin !== 'https://www.instagram.com') return false;
      if (new RegExp('^/api/v1/media/' + mediaId + '/comments(?:/|$)').test(url.pathname)) return true;
      if (!/^\/(?:api\/)?graphql\/query\/?$/.test(url.pathname)) return false;
      const params = typeof body === 'string' || body instanceof URLSearchParams ? new URLSearchParams(body) : url.searchParams;
      const name = params.get('fb_api_req_friendly_name') ?? params.get('friendly_name');
      if (!name || !/comment/i.test(name)) return false;
      const variables = JSON.parse(params.get('variables') ?? '{}');
      return [variables, variables.request, variables.data].some(group => group
        && [group.media_id, group.mediaId, group.mediaID].some(value => String(value ?? '') === mediaId));
    } catch { return false; }
  };
  const parse = (text) => {
    if (!state.open || typeof text !== 'string' || text.length > 800_000) return;
    try { collect(JSON.parse(text.replace(/^for\s*\(;;\);/, ''))); } catch { return false; }
    return true;
  };
  if (action === 'read') {
    const stillOnPost = () => location.origin === 'https://www.instagram.com'
      && /^\/(?:[\w.]{1,30}\/)?(?:p|reels?|tv)\/([\w-]{1,32})\/?$/.exec(location.pathname)?.[1] === shortcode;
    if (!stillOnPost()) return { comments, check: 'NAVIGATION' };
    // The browser adds the Instagram session to this same-origin read. The public app ID identifies Instagram Web.
    return (async () => {
      const base = `/api/v1/media/${mediaId}/comments/`;
      const stopAt = Date.now() + 18_000;
      const maxRows = Number.isSafeInteger(expected) && expected > 0 ? Math.min(expected, 40) : 40;
      const stats = { firstPage: 0, pages: 0, replyRequests: 0 };
      let status = {};
      const result = () => ({ comments, check: comments.length ? 'READ' : 'NO_ROWS', ...status,
        stats: { ...stats, roots, advertisedReplies: [...advertisedReplies.values()].reduce((total, count) => total + count, 0),
          withoutText: withoutText.size } });
      const request = async (route, cursor, sort) => {
        if (!stillOnPost()) { status = { check: 'NAVIGATION' }; return null; }
        const remaining = stopAt - Date.now();
        if (remaining <= 0) { status = { check: 'REQUEST_FAILED' }; return null; }
        const query = new URLSearchParams({ can_support_threading: 'true' });
        if (cursor) query.set(...cursor);
        if (sort) query.set('sort_order', sort);
        try {
          const response = await fetch(`${route}?${query}`, { credentials: 'same-origin', redirect: 'manual',
            headers: { 'X-IG-App-ID': '936619743392459', accept: 'application/json' }, signal: AbortSignal.timeout(Math.min(6500, remaining)) });
          if (!stillOnPost()) status = { check: 'NAVIGATION' };
          else if (response.type === 'opaqueredirect' || [401, 403].includes(response.status)) status = { check: 'SESSION_REQUIRED' };
          else if (response.status === 429) status = { check: 'RATE_LIMITED' };
          else if (!response.ok) status = { check: 'HTTP_ERROR', httpStatus: response.status };
          else if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) status = { check: 'NON_JSON' };
          else if (Number(response.headers.get('content-length')) > 800_000) status = { check: 'INVALID_DATA' };
          else {
            const body = await response.text();
            if (body.length <= 800_000) return JSON.parse(body.replace(/^for\s*\(;;\);/, ''));
            status = { check: 'INVALID_DATA' };
          }
        } catch (error) {
          status = { check: error instanceof SyntaxError ? 'INVALID_DATA' : 'REQUEST_FAILED' };
        }
        return null;
      };
      const queueCursors = (data, used, fields, pending) => {
        for (const [param, field] of fields) {
          const value = data?.[field];
          if (typeof value !== 'string' || !value || value.length > 4096) continue;
          const key = `${param}:${value}`;
          if (used.has(key)) continue;
          used.add(key);
          pending.push([param, value]);
        }
      };
      const readRoots = async (sort, maxPages) => {
        const pending = [null], used = new Set();
        while (pending.length && stats.pages < maxPages && roots < limit && comments.length < maxRows) {
          const page = await request(base, pending.shift(), sort);
          if (!page) return;
          stats.pages++;
          if (Number.isSafeInteger(page.comment_count) && page.comment_count >= 0) stats.reported = page.comment_count;
          collect(page.comments);
          collect(page.preview_comments);
          if (stats.pages === 1) stats.firstPage = comments.length;
          queueCursors(page, used, [['min_id', 'next_min_id'], ['max_id', 'next_max_id']], pending);
        }
      };
      const readReplies = async (attempted) => {
        for (const [parent, count] of advertisedReplies) {
          if (comments.length >= maxRows || stats.replyRequests >= 12) break;
          if ((replyCounts.get(parent) ?? 0) >= count || attempted.has(parent)) continue;
          attempted.add(parent);
          const pending = [null], used = new Set();
          while (pending.length && stats.replyRequests < 12 && comments.length < maxRows && (replyCounts.get(parent) ?? 0) < count) {
            stats.replyRequests++;
            const page = await request(`${base}${parent}/child_comments/`, pending.shift());
            if (!page) return;
            collect(page.child_comments, parent);
            queueCursors(page, used, [['min_id', 'next_min_child_cursor'], ['max_id', 'next_max_child_cursor']], pending);
          }
          const inline = inlineCursors.get(parent);
          if (inline && inline.length <= 4096 && stats.replyRequests < 12 && comments.length < maxRows && (replyCounts.get(parent) ?? 0) < count) {
            stats.replyRequests++;
            const page = await request(`${base}${parent}/inline_child_comments/`, ['max_id', inline]);
            if (!page) return;
            collect(page.child_comments, parent);
          }
        }
      };
      const attempted = new Set();
      await readRoots(null, 5);
      if (!status.check) await readReplies(attempted);
      if (!status.check && comments.length && expected > comments.length && comments.length < maxRows && stats.pages < 5 && roots < limit) {
        // The normal recent view may expose a root omitted by the default ranking.
        await readRoots('recent', Math.min(5, stats.pages + 2));
        if (!status.check) await readReplies(attempted);
      }
      return result();
    })();
  }
  window[key] = state;
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  const fetchWrapper = async function (raw, options) {
    const relevant = matches(raw, options?.body);
    const response = await originalFetch.call(this, raw, options);
    if (relevant && response.ok && Number(response.headers.get('content-length')) < 800_000) {
      void response.clone().text().then(parse).catch(() => {});
    }
    return response;
  };
  const openWrapper = function (method, url, ...args) {
    requests.set(this, url);
    return originalOpen.call(this, method, url, ...args);
  };
  const sendWrapper = function (body) {
    if (matches(requests.get(this), body)) this.addEventListener('load', () => {
      if (this.status !== 200) return;
      if (this.responseType === 'json') collect(this.response);
      else if (this.responseType === '' || this.responseType === 'text') parse(this.responseText);
    }, { once: true });
    return originalSend.call(this, body);
  };
  window.fetch = fetchWrapper;
  XMLHttpRequest.prototype.open = openWrapper;
  XMLHttpRequest.prototype.send = sendWrapper;
  state.close = () => {
    state.open = false;
    if (window.fetch === fetchWrapper) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === openWrapper) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === sendWrapper) XMLHttpRequest.prototype.send = originalSend;
    if (window[key] === state) delete window[key];
  };
  setTimeout(state.close, 25_000);
  return true;
}
