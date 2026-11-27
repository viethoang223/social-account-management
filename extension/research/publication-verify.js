import { facebookIdentity } from '../facebook-url.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs in the signed-in document. Read only, including when no proof is found.
export async function readPublicationEvidence(uid, caption, from, until, deadline) {
  const origin = 'https://www.facebook.com';
  const message = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"]';
  const card = 'article,[role="article"],[role="group"][aria-label*="Bài viết"],[role="group"][aria-label*="Post"]';
  const normalize = s => typeof s === 'string' ? s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC').trim() : '';
  const expected = normalize(caption);
  const allowed = () => location.origin === origin && Date.now() < deadline && !document.querySelector('input[name="pass"]');
  const results = new Map();
  const visited = new WeakSet();

  function postLink(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || url.username || url.password || url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;
      const path = url.pathname.replace(/\/+$/, '');
      const direct = /^(?:\/[^/]+)?\/posts\/([\w]+)$/.exec(path);
      const story = path === '/permalink.php' || path === '/story.php';
      const id = direct?.[1] ?? (story ? url.searchParams.get('story_fbid') : null);
      const owner = story ? url.searchParams.get('id') : /^\/(\d+)\/posts\//.exec(path)?.[1];
      if (!id || !/^\w{1,150}$/.test(id) || (owner && owner !== uid)) return null;
      for (const key of [...url.searchParams.keys()]) if (!['id', 'story_fbid'].includes(key)) url.searchParams.delete(key);
      url.hash = '';
      return { id, permalink: url.href, owner };
    } catch { return null; }
  }

  function timestamp(value) {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
      const number = Number(value);
      return number < 10_000_000_000 ? number * 1_000 : number;
    }
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  }

  const onPost = postLink(location.href);
  function record(link, actor, body, when) {
    if (!link || (onPost && link.id !== onPost.id) || actor !== uid || normalize(body) !== expected || !expected
      || !Number.isSafeInteger(when) || when < from || when > until) return;
    results.set(link.id, { uid, caption: expected, createdAt: when, permalink: link.permalink });
  }

  function scanScripts() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (visited.has(script)) continue;
      visited.add(script);
      const data = script.textContent;
      if (!data || data.length > 8_000_000 || !(data.includes('creation_time') || data.includes('created_time'))) continue;
      let root;
      try { root = JSON.parse(data); } catch { continue; }
      const stack = [root];
      for (let steps = 0; stack.length && steps < 180_000 && allowed() && results.size < 2; steps++) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (!Array.isArray(node)) {
          const story = node.comet_sections?.content?.story;
          const context = node.comet_sections?.context_layout?.story;
          const body = story?.comet_sections?.message?.story?.message?.text ?? story?.message?.text ?? node.message?.text;
          if (normalize(body) === expected) {
            const actors = node.actors ?? context?.actors ?? story?.actors;
            const actor = Array.isArray(actors) && actors.length === 1 ? String(actors[0]?.id ?? '') : null;
            const sections = node.comet_sections;
            const details = context?.comet_sections?.metadata ?? sections?.metadata;
            const times = Array.isArray(details) ? details.map(item => item?.story?.creation_time) : [];
            const when = timestamp(node.creation_time ?? node.created_time ?? context?.creation_time ?? story?.creation_time
              ?? times.find(value => value != null));
            const link = postLink(node.permalink_url ?? context?.permalink_url ?? story?.permalink_url ?? node.url);
            record(link, actor ?? link?.owner, body, when);
          }
        }
        for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  function scanCards() {
    const main = document.querySelector('main,[role="main"]') ?? document;
    for (const body of main.querySelectorAll(message)) {
      if (!body.getClientRects().length || normalize(body.innerText) !== expected) continue;
      const scope = body.closest(card);
      if (!scope || scope.parentElement?.closest(card)) continue;
      const bodies = [...scope.querySelectorAll(message)].filter(node => node.closest(card) === scope && node.getClientRects().length);
      if (bodies.some(node => normalize(node.innerText) !== expected)) continue;
      const seconds = [...scope.querySelectorAll('time[datetime],abbr[data-utime],[data-testid="story-subtitle"] [data-utime]')]
        .filter(time => time.closest(card) === scope).map(time => timestamp(time.getAttribute('datetime') ?? time.getAttribute('data-utime')));
      for (const anchor of scope.querySelectorAll('a[href]')) {
        if (anchor.closest(card) !== scope || body.contains(anchor)) continue;
        const link = postLink(anchor.href);
        const time = anchor.querySelector('time[datetime],abbr[data-utime]');
        const when = time ? timestamp(time.getAttribute('datetime') ?? time.getAttribute('data-utime')) : seconds.length === 1 ? seconds[0] : NaN;
        record(link, link?.owner, body.innerText, when);
      }
    }
  }

  for (let step = 0; step < (onPost ? 5 : 11) && allowed() && results.size < 2; step++) {
    scanScripts();
    scanCards();
    if (!onPost) window.scrollBy(0, Math.max(window.innerHeight * 0.8, 520));
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return allowed() ? [...results.values()].slice(0, 2) : null;
}

export async function verifyOldPublication(command, uid, deadline, sameUid) {
  const profile = 'https://www.facebook.com/profile.php?id=' + encodeURIComponent(uid);
  const read = async (url, tabDeadline, active) => {
    const identity = facebookIdentity(url);
    if (!identity || Date.now() >= tabDeadline || !await sameUid()) return null;
    const tab = await chrome.tabs.create({ url, active });
    if (tab.id === undefined) return null;
    try {
      while (Date.now() < tabDeadline) {
        const current = await chrome.tabs.get(tab.id);
        if (current.status === 'complete' && !current.pendingUrl && facebookIdentity(current.url) === identity) {
          if (!await sameUid()) return null;
          const [evidence] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPublicationEvidence,
            args: [uid, command.caption, command.from, command.until, tabDeadline] });
          const after = await chrome.tabs.get(tab.id);
          return await sameUid() && facebookIdentity(after.url) === identity ? evidence?.result ?? null : null;
        }
        await wait(250);
      }
      return null;
    } finally {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (facebookIdentity(current?.url) === identity) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  };
  const candidates = await read(profile, Math.min(deadline - 20_000, Date.now() + 35_000), true);
  if (!candidates) return null;
  if (candidates.length !== 1) return { candidates, reopened: false };
  const candidate = candidates[0];
  const reopened = await read(candidate.permalink, deadline - 5_000, true);
  return { candidates, reopened: reopened?.length === 1 && reopened[0].createdAt === candidate.createdAt
    && facebookIdentity(reopened[0].permalink) === facebookIdentity(candidate.permalink) };
}

// Runs in an owner-scoped Professional Dashboard tab. The table links carry the actual post ID.
export async function readCreatorPublications(uid, expectedCaption, previousIds, deadline) {
  const origin = 'https://www.facebook.com';
  if (location.origin !== origin || location.pathname.replace(/\/$/, '') !== '/professional_dashboard/content/content_library') return null;
  const normalize = value => (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const caption = normalize(expectedCaption);
  const previous = new Set(previousIds);
  const rows = new Map();
  while (Date.now() < deadline - 300 && !document.querySelector('input[name="pass"]')) {
    for (const anchor of document.querySelectorAll('a[href*="content_id="]')) {
      const url = new URL(anchor.href);
      if (url.origin !== origin || url.pathname.replace(/\/$/, '') !== '/content/insights') continue;
      let uidAndPost;
      try { uidAndPost = /^S:_I(\d+):(\d+):\2$/.exec(atob(url.searchParams.get('content_id') ?? '')); }
      catch { continue; }
      if (!uidAndPost || uidAndPost[1] !== uid) continue;
      const visibleTitle = anchor.querySelector('h1,h2,h3,h4,[role="heading"]')?.innerText ?? anchor.innerText;
      const label = anchor.getAttribute('aria-label')?.replace(/^(?:Post insights|Thông tin chi tiết về bài viết),\s*/i, '');
      const match = Boolean(caption) && [visibleTitle, label].some(title => normalize(title) === caption);
      const id = uidAndPost[2];
      rows.set(id, Boolean(rows.get(id) || match));
    }
    if (rows.size && (!caption || [...rows].some(([id, match]) => match && !previous.has(id)))) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return rows.size ? [...rows].map(([id, captionMatches]) => ({ id, captionMatches })) : null;
}

// Reopen the exact post. A Content Library row alone does not establish Public visibility.
export async function confirmCreatorPublicPost(uid, id, caption, deadline) {
  const url = new URL(location.href);
  if (url.origin !== 'https://www.facebook.com' || url.pathname !== '/permalink.php'
    || url.searchParams.get('id') !== uid || url.searchParams.get('story_fbid') !== id) return false;
  const normalize = value => value.normalize('NFC').replace(/\s+/g, ' ').trim();
  const wanted = normalize(caption);
  if (!wanted) return false;
  const scopeSelector = 'article,[role="article"],[role="dialog"],main,[role="main"]';
  const messageSelector = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"]';
  const publicLabel = /^(?:shared with public|currently sharing with public|edit audience\. currently sharing with public|chia sẻ công khai|chia sẻ với công khai|chỉnh sửa đối tượng\. hiện đang chia sẻ công khai)\.?$/i;
  while (Date.now() < deadline - 200 && location.href === url.href && !document.querySelector('input[name="pass"]')) {
    const scopeList = [...document.querySelectorAll(scopeSelector)];
    for (const scope of scopeList) {
      const messages = [...scope.querySelectorAll(messageSelector)].filter(node => node.getClientRects().length
        && !node.closest('[aria-hidden="true"]'));
      if (!messages.length || messages.some(node => normalize(node.innerText) !== wanted)) continue;
      const audiences = [...scope.querySelectorAll('[aria-label],[title]')].filter(node => node.getClientRects().length
        && !node.closest('[aria-hidden="true"]') && [node.getAttribute('aria-label'), node.getAttribute('title')]
          .some(label => label && publicLabel.test(label.trim())));
      const photo = scope.querySelector('a[href*="/photo"][href*="fbid="], [data-ad-rendering-role="story_attachment"] img');
      if (audiences.length && photo?.getClientRects().length && !photo.closest('[aria-hidden="true"]')) return true;
    }
    await new Promise(resolve => setTimeout(resolve, 280));
  }
  return false;
}

export async function readOnCreatorTab(url, deadline, sameUid, func, args) {
  if (Date.now() >= deadline || !await sameUid()) return null;
  const expected = new URL(url);
  const samePage = raw => {
    if (!raw) return false;
    const actual = new URL(raw);
    return actual.origin === expected.origin && actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')
      && ['story_fbid', 'id'].every(key => actual.searchParams.get(key) === expected.searchParams.get(key));
  };
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id === undefined) return null;
  try {
    while (Date.now() < deadline - 400) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete' && !current.pendingUrl && samePage(current.url) && await sameUid()) {
        const [evidence] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: [...args, deadline] });
        const after = await chrome.tabs.get(tab.id);
        return samePage(after.url) && await sameUid() ? evidence?.result ?? null : null;
      }
      await wait(250);
    }
    return null;
  } finally {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (samePage(current?.url)) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
