/** Read a timeline or a post inside the job's own Facebook document. */
export async function readResearch(mode, requested, limit, deadline, expectedCaption) {
  const origin = 'https://www.facebook.com';
  const article = 'article,[role="article"]';
  const message = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"]';
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
  const messageBlocks = scope => {
    const candidates = own(scope, message).filter(node => text(node));
    const innermost = candidates.filter(node => !candidates.some(other => other !== node && node.contains(other)));
    return [...new Map(innermost.map(node => [text(node), node])).values()];
  };
  const caption = scope => {
    const blocks = messageBlocks(scope);
    const body = blocks.length === 1 ? text(blocks[0]) : '';
    return { body: body.replace(/\s+(?:xem thêm|see more)$/i, ''),
      captionPartial: blocks.length > 1 || /(?:…|\.{3}|xem thêm|see more)$/i.test(body),
    };
  };
  const knownCaption = scope => {
    const data = caption(scope);
    if (!expectedCaption) return data;
    const compare = value => value.normalize('NFC').replace(/\s+/g, ' ').trim();
    const wanted = compare(expectedCaption);
    if (compare(data.body) === wanted) return data;
    const withEmoji = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.nodeName === 'BR') return ' ';
      if (node.nodeName === 'IMG') return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(node.alt) ? node.alt : '';
      const contents = [...node.childNodes].map(withEmoji).join('');
      return /^(?:DIV|P|LI)$/.test(node.nodeName) ? contents + ' ' : contents;
    };
    const candidates = data.body ? messageBlocks(scope) : own(scope, '[dir="auto"],p')
      .filter(el => !el.closest('a,button,[role="button"],textarea'));
    return candidates.some(el => compare(text(el)) === wanted
      || (el.querySelector('img[alt]') && compare(withEmoji(el)) === wanted))
      ? { body: expectedCaption, captionPartial: false } : data;
  };
  const openedCaptions = new WeakSet();
  const revealMatchingCaption = async card => {
    if (!expectedCaption) return;
    const expand = named(card, control, expandText).filter(button => !isComment(button.closest(article)));
    if (expand.length !== 1 || openedCaptions.has(expand[0])) return;
    const normalize = value => value.normalize('NFC').replace(/\s+/g, ' ').trim();
    const wanted = normalize(expectedCaption);
    const matchesPrefix = node => {
      const prefix = normalize(text(node).replace(/\s*(?:xem thêm|see more)\s*$/i, '').replace(/\s*(?:…|\.{3})\s*$/, ''));
      return prefix.length > 0 && wanted.startsWith(prefix);
    };
    const nearby = messageBlocks(card);
    for (let scope = expand[0].parentElement; scope && scope !== card; scope = scope.parentElement) nearby.push(scope);
    if (!nearby.some(matchesPrefix)) return;
    openedCaptions.add(expand[0]);
    expand[0].click();
    await pause(300);
  };
  if (!allowed()) return null;
  if (mode === 'profile' || mode === 'publication') {
    const main = document.querySelector('main,[role="main"]');
    if (!main) return null;
    const publication = mode === 'publication';
    const loadFirstPostsUntil = publication && expectedCaption
      ? Math.min(Date.now() + 7500, deadline - 700) : 0;
    const rows = new Map();
    let still = 0;
    for (let round = 0; round < 27 && allowed() && rows.size < limit; round++) {
      const before = rows.size;
      const cards = all(main, article).filter(card => !isComment(card)
        && (!publication || !card.parentElement.closest(article)));
      if (publication) {
        const actions = named(main, control, /^(?:Actions for this post|Hành động cho bài viết|Tùy chọn bài viết)(?:\s|$)/i);
        for (const button of actions) {
          if (cards.some(card => card.contains(button))) continue;
          for (let scope = button.parentElement; scope && scope !== main; scope = scope.parentElement) {
            if (actions.some(other => other !== button && scope.contains(other))) break;
            if (own(scope, heading).some(anchor => person(anchor.href)) && knownCaption(scope).body
              && own(scope, 'a[href]').some(anchor => post(anchor.href))) {
              cards.push(scope);
              break;
            }
          }
        }
      }
      for (const card of cards) {
        const inCard = anchor => card.matches(article) ? anchor.closest(article) === card : !isComment(anchor.closest(article));
        const links = own(card, 'a[href]').filter(inCard);
        const direct = links.map(anchor => post(anchor.href)).filter(item => item &&
          (!publication || /\/(?:posts\/|reel\/|videos\/|photo(?:\.php)?(?:\/|$)|story\.php|permalink\.php)/.test(new URL(item.url).pathname)));
        if (!direct.length || rows.has(direct[0].id)) continue;
        if (publication && expectedCaption) await revealMatchingCaption(card);
        if (!card.isConnected) continue;
        const metadata = publication ? knownCaption(card) : caption(card);
        const title = own(card, heading).map(text).find(Boolean) || 'Bài trên Facebook';
        const authorUrl = publication ? own(card, heading)
          .filter(inCard).map(anchor => person(anchor.href)).find(Boolean) : null;
        rows.set(direct[0].id, { url: direct[0].url, title, ...metadata, ...(publication && { authorUrl }) });
        if (rows.size === limit) break;
      }
      still = before === rows.size ? still + 1 : 0;
      const loadingFirstPosts = !rows.size && Date.now() < loadFirstPostsUntil;
      if (rows.size === limit || (still >= 4 && !loadingFirstPosts) || deadline - Date.now() < 500) break;
      if (loadingFirstPosts) {
        window.scrollBy(0, Math.max(300, Math.floor(window.innerHeight * 0.7)));
      } else {
        (cards.at(-1) ?? main).scrollIntoView({ block: 'end' });
        window.scrollBy(0, Math.max(window.innerHeight, 700));
      }
      await pause(420);
    }
    const creatorLibrary = publication && expectedCaption && all(main, 'a[href]').map(anchor => link(anchor.href))
      .find(url => url?.pathname.replace(/\/$/, '') === '/professional_dashboard/content/content_library');
    return allowed() ? { url: location.href, value: { rows: [...rows.values()], ended: still >= 4,
      ...(creatorLibrary && { creatorLibrary: creatorLibrary.origin + creatorLibrary.pathname }) } } : null;
  }
  const targetId = post(requested)?.id;
  const unable = issue => ({ url: location.href, issue });
  if (!targetId) return null;
  const destination = new URL(requested);
  const path = destination.pathname.replace(/\/+$/, '');
  const reel = path.startsWith('/reel/');
  const reelView = reel ? globalThis.__seedingReelComments : null;
  const onTarget = () => allowed() && post(location.href)?.id === targetId
    && (!reel || (location.pathname.replace(/\/+$/, '') === path && reelView?.path === path
      && reelView.panel.isConnected && visible(reelView.panel)));
  if (!onTarget()) return reel ? unable('Khung bình luận không còn thuộc Reel đang đọc.') : null;
  const ownerId = destination.searchParams.get('id');
  const ownerHref = /^\d+$/.test(ownerId ?? '') ? origin + '/profile.php?id=' + ownerId : null;
  const ownerLink = scope => ownerHref && own(scope, 'a[href]').find(anchor =>
    !isComment(anchor.closest(article)) && person(anchor.href) === ownerHref && text(anchor));
  const commentPostId = url => {
    url.searchParams.delete('comment_id');
    url.searchParams.delete('reply_comment_id');
    return post(url.href)?.id;
  };
  const hasTargetComment = scope => all(scope, 'a[href*="comment_id="]').some(anchor => {
    const url = link(anchor.href);
    return url && commentPostId(url) === targetId;
  });
  const single = items => items.length === 1 ? items[0] : null;
  const openUntil = Math.min(deadline, Date.now() + 8000);
  let main, initial = reelView?.panel;
  while (!initial && Date.now() < openUntil) {
    if (!onTarget()) return null;
    main = document.querySelector('main,[role="main"]');
    const dialogs = all(document, '[role="dialog"],dialog').filter(dialog =>
      own(dialog, message).length > 0 || hasTargetComment(dialog) || ownerLink(dialog));
    const innermost = dialogs.filter(dialog => !dialogs.some(other => other !== dialog && dialog.contains(other)));
    initial = single(innermost) ?? main;
    if (!initial) await pause(200);
  }
  if (!initial) return unable('Chưa thấy vùng bài viết trên trang đã tải.');
  const cards = reel ? [] : all(initial, article).filter(card => !isComment(card) && own(card, message).length);
  const matchesPost = card => own(card, 'a[href]').some(anchor => anchor.closest(article) === card && post(anchor.href)?.id === targetId);
  const primary = single(cards.filter(matchesPost)) ?? single(cards);
  const content = reelView?.content ?? primary ?? initial;
  if (!primary && initial === main && messageBlocks(content).length > 1) {
    return unable('Trang có nhiều vùng nội dung bài chồng nhau.');
  }
  const bodyNode = () => single(messageBlocks(content));
  const moreCaption = bodyNode() && single(named(bodyNode(), control, expandText));
  if (moreCaption && onTarget()) {
    moreCaption.click();
    await pause(350);
  }
  const replyLoader = /^(?:(?:xem|hiển thị|view|see|show) (?:thêm |more |previous |all |tất cả )?(?:\d+ )?(?:bình luận|phản hồi|câu trả lời|replies|comments)(?: khác| trước| nữa| more)?|\d+ (?:phản hồi|câu trả lời|replies))$/i;
  const orderMenu = single(named(initial, control, /^(?:phù hợp nhất|most relevant|mới nhất|newest)$/i));
  if (orderMenu && onTarget()) {
    orderMenu.click();
    await pause(250);
    if (!onTarget()) return null;
    const showAll = single(named(document, '[role="menuitem"],[role="menuitemradio"],[role="option"]', /^(?:tất cả bình luận|all comments)$/i));
    if (showAll) showAll.click();
    else orderMenu.click();
  }
  const readComments = () => {
    const nodes = all(initial, article).filter(isComment);
    const result = [], depthByCard = new Map(), seen = new Set();
    let roots = 0, truncated = false;
    for (const card of nodes) {
      const links = own(card, 'a[href]');
      const references = links.map(anchor => link(anchor.href)).filter(Boolean).flatMap(url => {
        const root = url.searchParams.get('comment_id');
        const reply = url.searchParams.get('reply_comment_id');
        if (!root && !reply) return [];
        const postId = commentPostId(url);
        return postId ? [{ root, reply, postId }] : [];
      });
      const direct = references.find(ids => ids.postId === targetId);
      if (!direct && references.length) continue;
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
      result.push({ externalId, parentExternalId, rootExternalId: direct?.root ?? null,
        authorUrl: name ? person(name.href) : null, originalName: text(name), text: body, depth });
    }
    return { result, roots, truncated };
  };
  let collected = readComments(), quiet = 0, loaders = [];
  for (let round = 0; round < 18 && onTarget() && quiet < 3; round++) {
    loaders = named(initial, control, replyLoader).filter(button =>
      collected.roots < limit || !title(button).some(name => /(?:bình luận|comments)/i.test(name)));
    if (loaders.length) loaders.slice(0, 4).forEach(button => button.click());
    else if (collected.roots >= limit) break;
    else (all(initial, article).filter(isComment).at(-1) ?? (reel ? initial : content)).scrollIntoView({ block: 'end' });
    await pause(380);
    const next = readComments();
    quiet = next.result.length === collected.result.length ? quiet + 1 : 0;
    collected = next;
  }
  if (!onTarget()) return null;
  const author = ownerLink(content) ?? own(content, heading).find(anchor => person(anchor.href) && text(anchor));
  const video = own(content, 'video')[0];
  const sourceKind = reel ? 'reel' : /\/(?:watch|videos)(?:\/|$)/.test(path) || video ? 'video' : 'post';
  const images = own(content, 'img').filter(img => img.naturalWidth >= 200
    && (img.closest('a[href*="fbid="]') || img.closest('[data-ad-preview="media"],[data-ad-comet-preview="media"]'))).map(img => img.currentSrc || img.src);
  const gallery = own(content, 'a[href*="set=pcb"]').at(0)?.href;
  const preview = caption(content);
  if (!preview.body && !author && !collected.result.length && !images.length && !video && sourceKind === 'post' && !primary) {
    return unable('Vùng bài mở được nhưng chưa đọc được tác giả, nội dung hoặc bình luận.');
  }
  const locationLink = own(content, 'a[href*="/places/"],a[href*="/checkin/"]').find(anchor => text(anchor));
  return { url: location.href, value: { ...preview, author: text(author), authorURL: author ? person(author.href) : null,
    location: text(locationLink), images, gallery, more: Boolean(gallery), video: Boolean(video || sourceKind !== 'post'),
    videoURL: video?.currentSrc, videoLinks: sourceKind === 'post' ? [] : [requested], sourceKind,
    comments: collected.result, stoppedEarly: collected.truncated || loaders.length > 0 } };
}
