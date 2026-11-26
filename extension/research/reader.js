/** Read a timeline or a post inside the job's own Facebook document. */
export async function readResearch(mode, requested, limit, deadline) {
  const origin = 'https://www.facebook.com';
  const article = 'article,[role="article"]';
  const message = '[data-ad-preview="message"],[data-ad-comet-preview="message"]';
  const heading = 'header a[href],h2 a[href],h3 a[href],h4 a[href],[role="heading"] a[href]';
  const control = 'button,[role="button"]';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const allowed = () => Date.now() < deadline && location.origin === origin && !document.querySelector('input[name="pass"]');
  const text = el => (el?.innerText ?? '').trim();
  const visible = el => el.getClientRects().length && !el.closest('[aria-hidden="true"]');
  const all = (scope, selector) => [...scope.querySelectorAll(selector)].filter(visible);
  const isComment = card => /^(?:bình luận|phản hồi|đáp lại|comment|reply|replied)\b/i.test(card?.getAttribute('aria-label') ?? '');
  const own = (scope, selector) => all(scope, selector).filter(el => !isComment(el.closest(article)) || el.closest(article) === scope);
  const title = el => [el.getAttribute('aria-label'), text(el)].filter(Boolean);
  const named = (scope, selector, pattern) => all(scope, selector).filter(el => title(el).some(s => pattern.test(s)));
  const link = raw => {
    try {
      const url = new URL(raw);
      return /^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\//.test(url.href) ? url : null;
    } catch { return null; }
  };
  const post = raw => {
    const url = link(raw);
    if (!url) return null;
    const pathname = url.pathname.replace(/\/$/, '');
    const keys = { '/story.php': 'story_fbid', '/permalink.php': 'story_fbid', '/photo': 'fbid', '/photo.php': 'fbid', '/watch': 'v' };
    const id = /\/(?:posts|videos|reel)\/(\w+)$/.exec(pathname)?.[1] ?? url.searchParams.get(keys[pathname] ?? '_');
    if (!id || !/^\w{1,200}$/.test(id) || url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;
    for (const key of [...url.searchParams.keys()]) if (!['id', 'story_fbid', 'fbid', 'v'].includes(key)) url.searchParams.delete(key);
    url.hostname = 'www.facebook.com';
    url.hash = '';
    return { url: url.href, id };
  };
  const person = raw => {
    const url = link(raw);
    if (!url) return null;
    const pathname = url.pathname.replace(/\/$/, '');
    if (pathname === '/profile.php' && /^\d+$/.test(url.searchParams.get('id') ?? '')) {
      return origin + '/profile.php?id=' + url.searchParams.get('id');
    }
    if (/^\/people\/[^/]+\/\d+$/.test(pathname) || (/^\/[a-z\d.]+$/i.test(pathname)
      && !/^(?:about|checkpoint|dialog|events|friends|gaming|groups|help|home\.php|login(?:\.php)?|marketplace|me|notifications|pages|people|photo(?:\.php)?|plugins|policies|privacy|profile\.php|reels?|search|settings|share(?:\.php)?|stories|story\.php|watch)$/i.test(pathname.slice(1)))) {
      return origin + pathname;
    }
    return null;
  };
  const expandText = /^(?:xem thêm|see more)$/i;
  const caption = scope => {
    const blocks = own(scope, message);
    const body = blocks.length === 1 ? text(blocks[0]) : '';
    return { body: body.replace(/\s+(?:xem thêm|see more)$/i, ''),
      captionPartial: blocks.length > 1 || /(?:…|\.{3}|xem thêm|see more)$/i.test(body),
    };
  };
  const path = new URL(requested).pathname.replace(/\/+$/, '');
  const reel = mode === 'post' && path.startsWith('/reel/');
  const reelView = reel ? globalThis.__seedingReelComments : null;
  const main = document.querySelector('main,[role="main"]');
  if (!allowed() || (reel ? reelView?.path !== path || !reelView.panel.isConnected : !main)) return null;
  if (mode === 'profile') {
    const rows = new Map();
    let still = 0;
    for (let round = 0; round < 27 && allowed() && rows.size < limit && still < 4; round++) {
      const before = rows.size;
      const cards = all(main, article).filter(card => !isComment(card));
      for (const card of cards) {
        const direct = own(card, 'a[href]').filter(anchor => anchor.closest(article) === card)
          .map(anchor => post(anchor.href)).filter(Boolean);
        if (!direct.length || rows.has(direct[0].id)) continue;
        const metadata = caption(card);
        const title = own(card, heading).map(text).find(Boolean) || 'Bài trên Facebook';
        rows.set(direct[0].id, { url: direct[0].url, title, ...metadata });
        if (rows.size === limit) break;
      }
      still = before === rows.size ? still + 1 : 0;
      if (rows.size === limit || still === 4) break;
      (cards.at(-1) ?? main).scrollIntoView({ block: 'end' });
      window.scrollBy(0, Math.max(window.innerHeight, 700));
      await pause(420);
    }
    return allowed() ? { url: location.href, value: { rows: [...rows.values()], ended: still === 4 } } : null;
  }
  const targetId = post(requested)?.id;
  if (!targetId || post(location.href)?.id !== targetId) return null;
  const single = items => items.length === 1 ? items[0] : null;
  const initial = reelView?.panel ?? (single(all(document, '[role="dialog"]').filter(dialog => own(dialog, message).length > 0)) ?? main);
  const cards = reel ? [] : all(initial, article).filter(card => !isComment(card) && own(card, message).length);
  const matchesPost = card => own(card, 'a[href]').some(anchor => anchor.closest(article) === card && post(anchor.href)?.id === targetId);
  const primary = single(cards.filter(matchesPost)) ?? single(cards);
  const content = reelView?.content ?? primary ?? initial;
  if (!reel && !primary && own(content, message).length > 1) return null;
  const bodyNode = () => single(own(content, message));
  const moreCaption = bodyNode() && single(named(bodyNode(), control, expandText));
  if (moreCaption && allowed()) {
    moreCaption.click();
    await pause(350);
  }
  const replyLoader = /^(?:(?:xem|hiển thị|view|see|show) (?:thêm |more |previous |all |tất cả )?(?:\d+ )?(?:bình luận|phản hồi|câu trả lời|replies|comments)(?: khác| trước| nữa| more)?|\d+ (?:phản hồi|câu trả lời|replies))$/i;
  const orderMenu = single(named(initial, control, /^(?:phù hợp nhất|most relevant|mới nhất|newest)$/i));
  if (orderMenu && allowed()) {
    orderMenu.click();
    await pause(250);
    const showAll = single(named(document, '[role="menuitem"],[role="menuitemradio"],[role="option"]', /^(?:tất cả bình luận|all comments)$/i));
    if (showAll) showAll.click();
    else if (allowed()) orderMenu.click();
  }
  const readComments = () => {
    const nodes = all(initial, article).filter(isComment);
    const result = [], depthByCard = new Map(), seen = new Set();
    let roots = 0, truncated = false;
    for (const card of nodes) {
      const links = own(card, 'a[href]');
      const direct = links.map(anchor => link(anchor.href)).filter(Boolean).flatMap(url => {
        const root = url.searchParams.get('comment_id');
        const reply = url.searchParams.get('reply_comment_id');
        if (!root && !reply) return [];
        url.searchParams.delete('comment_id');
        url.searchParams.delete('reply_comment_id');
        const linkedPost = post(url.href);
        return linkedPost ? [{ root, reply, postId: linkedPost.id }] : [];
      }).at(0);
      if (direct && direct.postId !== targetId) continue;
      if (!direct && !primary?.contains(card) && initial === main) { truncated = true; continue; }
      const name = links.find(anchor => person(anchor.href) && text(anchor));
      const body = own(card, '[dir="auto"]').filter(el => el.closest(article) === card
        && !el.closest('a,button,[role="button"]') && !el.querySelector('[dir="auto"]'))
        .map(text).filter(value => value && value !== text(name) && !/^(tác giả|author|fan cứng|top fan)$/i.test(value)).join('\n');
      if (!body) continue;
      const parent = card.parentElement.closest(article);
      const nestedParent = depthByCard.get(parent);
      const rootSeen = direct?.root && seen.has(direct.root);
      const reply = !!direct?.reply || /^(?:phản hồi|đáp lại|reply|replied)\b/i.test(card.getAttribute('aria-label') ?? '');
      if (reply && !nestedParent && !rootSeen) { truncated = true; continue; }
      const depth = nestedParent ? nestedParent.depth + 1 : reply ? 1 : 0;
      if (depth === 0 && ++roots > limit) { truncated = true; break; }
      const externalId = direct?.reply ?? (!reply ? direct?.root : null) ?? null;
      if (externalId && seen.has(externalId)) continue;
      if (externalId) seen.add(externalId);
      depthByCard.set(card, { externalId, depth });
      const parentExternalId = nestedParent ? nestedParent.externalId : reply ? direct?.root : null;
      result.push({ externalId, parentExternalId, originalName: text(name), text: body, depth });
    }
    return { result, roots, truncated };
  };
  let collected = readComments(), quiet = 0, loaders = [];
  for (let round = 0; round < 18 && allowed() && quiet < 3; round++) {
    loaders = named(initial, control, replyLoader).filter(button =>
      collected.roots < limit || !title(button).some(name => /(?:bình luận|comments)/i.test(name)));
    if (loaders.length) loaders.slice(0, 4).forEach(button => button.click());
    else if (collected.roots >= limit) break;
    else (all(initial, article).filter(isComment).at(-1) ?? content).scrollIntoView({ block: 'end' });
    await pause(380);
    const next = readComments();
    quiet = next.result.length === collected.result.length ? quiet + 1 : 0;
    collected = next;
  }
  if (!allowed() || post(location.href)?.id !== targetId) return null;
  const author = own(content, heading).find(anchor => person(anchor.href) && text(anchor));
  const video = own(content, 'video')[0];
  const sourceKind = reel ? 'reel' : /\/(?:watch|videos)(?:\/|$)/.test(path) || video ? 'video' : 'post';
  const images = own(content, 'img').filter(img => img.naturalWidth >= 200
    && (img.closest('a[href*="fbid="]') || img.closest('[data-ad-preview="media"],[data-ad-comet-preview="media"]'))).map(img => img.currentSrc || img.src);
  const gallery = own(content, 'a[href*="set=pcb"]').at(0)?.href;
  const preview = caption(content);
  if (!preview.body && !collected.result.length && !images.length && !video && sourceKind === 'post' && !primary) return null;
  const locationLink = own(content, 'a[href*="/places/"],a[href*="/checkin/"]').find(anchor => text(anchor));
  return { url: location.href, value: { ...preview, author: text(author), authorURL: author ? person(author.href) : null,
    location: text(locationLink), images, gallery, more: Boolean(gallery), video: Boolean(video || sourceKind !== 'post'),
    videoURL: video?.currentSrc, videoLinks: sourceKind === 'post' ? [] : [requested], sourceKind,
    comments: collected.result, stoppedEarly: collected.truncated || loaders.length > 0 } };
}
