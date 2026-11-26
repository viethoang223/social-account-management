/** Runs in the same isolated document for prepare, inspect, and the single authorized click. */
export async function commentComposer(action, input) {
  const { postUrl, parentId, text, uid, deadline } = input;
  const active = () => Date.now() < deadline && location.origin === 'https://www.facebook.com';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normal = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC').trim();
  const visible = element => Boolean(element.getClientRects().length && !element.closest('[aria-hidden="true"]'));
  const label = (element, pattern) => ['aria-label', 'aria-placeholder', 'title', 'data-placeholder'].some(key => pattern.test(element.getAttribute(key) ?? ''));
  const article = 'article,[role="article"]';
  const commentLabel = /^(?:bình luận|phản hồi|đáp lại|comment|repl(?:y|ied))\b/i;
  const isComment = element => commentLabel.test(element.getAttribute('aria-label') ?? '');
  const own = (element, selector) => [...element.querySelectorAll(selector)].filter(item => visible(item) && item.closest(article) === element);
  const isPost = (url) => {
    const path = url.pathname.replace(/\/+$/, '');
    return /\/(?:posts|videos|reel)\/([\w]+)$/.exec(path)?.[1]
      ?? (['/story.php', '/permalink.php'].includes(path) ? url.searchParams.get('story_fbid') : null)
      ?? (['/photo', '/photo.php'].includes(path) ? url.searchParams.get('fbid') : null)
      ?? (path === '/watch' ? url.searchParams.get('v') : null);
  };
  const digits = value => {
    if (!value || /^\d+$/.test(value)) return value;
    try { return /^comment:\d+_(\d+)$/.exec(atob(value.replace(/-/g, '+').replace(/_/g, '/')))?.[1] ?? value; }
    catch { return value; }
  };
  const dest = new URL(postUrl);
  const destId = isPost(dest);
  const reel = dest.pathname.startsWith('/reel/');
  const reelView = reel ? globalThis.__seedingReelComments : null;
  const rootId = digits(dest.searchParams.get('comment_id'));
  const replyId = digits(dest.searchParams.get('reply_comment_id'));
  const here = () => active() && dest.origin === location.origin && destId && destId === isPost(new URL(location.href));
  if (!here() || (replyId || rootId || undefined) !== parentId) return null;
  const ids = href => {
    const url = new URL(href, location.href);
    if (url.origin !== dest.origin || isPost(url) !== destId) return null;
    const root = digits(url.searchParams.get('comment_id'));
    const reply = digits(url.searchParams.get('reply_comment_id'));
    return root ? { root, reply, id: reply || root } : null;
  };
  const matches = (scope, selector, check) => [...scope.querySelectorAll(selector)].filter(el => visible(el) && check(el));
  const one = items => items.length === 1 ? items[0] : null;
  const editors = scope => matches(scope, '[role="textbox"][contenteditable="true"]', () => true);
  const postScope = () => {
    if (reel) return reelView?.path === location.pathname.replace(/\/+$/, '') && reelView.panel.isConnected ? reelView.panel : null;
    const dialogues = matches(document, '[role="dialog"]', dialog => editors(dialog).length > 0);
    if (dialogues.length) return one(dialogues);
    return one(matches(document, 'main,[role="main"]', () => true));
  };
  const linkedPostIds = (scope, card = null) => [...new Set(matches(scope, 'a[href]', anchor => {
    const owner = anchor.closest(article);
    return card ? owner === card : !owner || !isComment(owner);
  }).map(anchor => {
    const url = new URL(anchor.href);
    return url.origin === dest.origin && !url.searchParams.has('comment_id') && !url.searchParams.has('reply_comment_id')
      ? isPost(url) : null;
  }).filter(Boolean))];
  const rootComposer = (scope, editor) => {
    const card = editor.closest(article);
    if (card && isComment(card)) return false;
    if (scope === reelView?.panel) return !card || !scope.contains(card);
    const linked = card ? linkedPostIds(card, card) : linkedPostIds(scope);
    if (linked.length) return linked.length === 1 && linked[0] === destId;
    const canonical = document.querySelector('link[rel="canonical"],meta[property="og:url"]')?.getAttribute('href')
      ?? document.querySelector('meta[property="og:url"]')?.content;
    if (card || !canonical) return false;
    const url = new URL(canonical, location.href);
    return url.origin === dest.origin && isPost(url) === destId;
  };
  const editorName = /^(?:(?:write|leave) (?:a |an |your )?(?:comment|reply)|viết (?:bình luận|phản hồi|câu trả lời)|trả lời|reply to)(?:[\s.…]|$)/i;
  const reelEditorName = /^(?:Bình luận dưới tên|Comment as)\s+\S/i;
  const replyName = /^(?:phản hồi|trả lời|reply)$/i;
  const sendName = /^(?:gửi bình luận|đăng bình luận|gửi phản hồi|đăng phản hồi|bình luận|comment|send comment|post comment|send reply|post reply)$/i;
  const controls = 'button,[role="button"],input[type="submit"]';
  const waitFor = async fn => {
    const until = Math.min(deadline, Date.now() + 7000);
    do {
      if (!here()) return null;
      const item = fn();
      if (item) return item;
      await pause(160);
    } while (Date.now() < until);
    return null;
  };
  const commentCards = scope => matches(scope, article, isComment);
  const links = card => own(card, 'a[href*="comment_id="]').map(a => ids(a.href)).filter(Boolean);
  const parentCard = scope => one(commentCards(scope).filter(card =>
    links(card).some(link => link.id === parentId && link.root === rootId)));
  const sendButton = (editor, scope) => {
    const form = reel && editor.closest('form');
    if (form && scope.contains(form)) {
      if (editors(form).length !== 1 || form.querySelector(article)) return null;
      const send = one(matches(form, controls, btn => label(btn, sendName) || sendName.test(normal(btn.innerText ?? ''))));
      return send && !send.matches(':disabled,[aria-disabled="true"]') ? send : null;
    }
    for (let area = editor.parentElement, level = 0; area && scope.contains(area) && level < 6; area = area.parentElement, level++) {
      if (editors(area).length !== 1 || area.querySelector(article)) return null;
      const buttons = matches(area, controls, btn => label(btn, sendName) || sendName.test(normal(btn.innerText ?? '')));
      if (buttons.length) return one(buttons.filter(btn => !btn.matches(':disabled,[aria-disabled="true"]')));
    }
    return null;
  };
  const verify = () => {
    const saved = globalThis.__seedingComment;
    if (!saved || saved.postUrl !== postUrl || saved.parentId !== parentId || saved.uid !== uid
      || !saved.scope.contains(saved.editor) || !saved.editor.isConnected || postScope() !== saved.scope
      || (parentId && parentCard(saved.scope) !== saved.parent)
      || (!parentId && !rootComposer(saved.scope, saved.editor))
      || normal(saved.editor.innerText) !== normal(text)) return null;
    return sendButton(saved.editor, saved.scope);
  };
  if (action === 'prepare') {
    const scope = await waitFor(postScope);
    if (!scope) return { problem: 'Không tìm thấy khung bình luận đã mở.' };
    const originalEditors = editors(scope);
    let parent = null;
    if (parentId) {
      parent = await waitFor(() => parentCard(scope));
      const reply = parent && one(own(parent, controls).filter(btn => label(btn, replyName) || replyName.test(normal(btn.innerText ?? ''))));
      if (!reply || !here()) return null;
      reply.click();
    }
    const editor = await waitFor(() => one(editors(scope).filter(item => {
      if (!parentId && scope === reelView?.panel) return rootComposer(scope, item);
      if (!label(item, editorName) && !(reel && label(item, reelEditorName))) return false;
      if (parentId) return !originalEditors.includes(item);
      return rootComposer(scope, item);
    })));
    if (!editor) return { problem: 'Không xác định được duy nhất ô bình luận trong khung.' };
    if (normal(editor.innerText) || !here()) return { problem: 'Ô bình luận không trống hoặc Reel đã thay đổi.' };
    editor.focus();
    if (reel) {
      const selection = window.getSelection();
      if (!selection) return { problem: 'Chrome chưa đặt được con trỏ trong ô bình luận.' };
      const cursor = document.createRange();
      cursor.selectNodeContents(editor);
      cursor.collapse(false);
      selection.removeAllRanges();
      selection.addRange(cursor);
      if (!editor.contains(selection.anchorNode)) return { problem: 'Con trỏ chưa ở trong đúng ô bình luận.' };
    }
    if (!document.execCommand('insertText', false, text)) return { problem: 'Chrome không cho nhập vào ô bình luận.' };
    globalThis.__seedingComment = { postUrl, parentId, uid, editor, scope, parent };
    if (await waitFor(verify)) return { ok: true };
    return { problem: normal(editor.innerText) === normal(text)
      ? 'Đã nhập nội dung, nhưng chưa xác nhận được nút gửi.'
      : 'Nội dung ô bình luận sau khi nhập không khớp.' };
  }
  const send = verify();
  if (!send || !here()) return null;
  if (action === 'inspect') return { ok: true };
  if (action !== 'commit') return null;
  const { scope } = globalThis.__seedingComment;
  const existing = new Set(commentCards(scope).flatMap(links).map(item => item.id));
  delete globalThis.__seedingComment;
  if (!here()) return null;
  send.click();
  const until = Date.now() + 5500;
  do {
    const fromUid = card => own(card, 'a[href]').some(link => {
      const url = new URL(link.href);
      return url.origin === dest.origin && (url.pathname === '/profile.php' && url.searchParams.get('id') === uid
        || /^\/people\/[^/]+\/(\d+)\/?$/.exec(url.pathname)?.[1] === uid);
    });
    const found = commentCards(scope).filter(card => fromUid(card)
      && own(card, '[dir="auto"]').some(body => !body.closest('a,button,[role="button"]') && normal(body.innerText) === normal(text)))
      .flatMap(links).filter(link => !existing.has(link.id) && (parentId ? link.root === rootId && link.reply && link.id !== parentId : !link.reply));
    const receipt = one([...new Map(found.map(link => [link.id, link])).values()]);
    if (receipt) {
      dest.searchParams.set('comment_id', receipt.root);
      if (receipt.reply) dest.searchParams.set('reply_comment_id', receipt.reply);
      return { ok: true, receipt: { externalId: receipt.id, permalink: dest.href } };
    }
    await pause(250);
  } while (Date.now() < until && isPost(new URL(location.href)) === destId);
  return { ok: true };
}
