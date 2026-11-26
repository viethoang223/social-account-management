import { facebookIdentity } from './facebook-url.js';

export function findPostedComment({ postUrl, parentId, uid, text }, before, after, knownCommentIds = []) {
  if (!before || before.stoppedEarly || !after) return null;
  const id = value => {
    if (/^\d+$/.test(value ?? '')) return value;
    try { return /^comment:\d+_(\d+)$/.exec(atob(value.replace(/-/g, '+').replace(/_/g, '/')))?.[1] ?? null; }
    catch { return null; }
  };
  const normal = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC').trim();
  const matches = row => facebookIdentity(row.authorUrl) === 'uid:' + uid && normal(row.text) === normal(text);
  // An existing matching comment without a stable ID might gain an ID in the second read.
  if (before.comments.some(row => matches(row) && !id(row.externalId))) return null;
  const previous = new Set([...knownCommentIds, ...before.comments.map(row => row.externalId)].map(id));
  const url = new URL(postUrl);
  const root = id(url.searchParams.get('comment_id'));
  const candidates = after.comments.filter(row => {
    const nativeId = id(row.externalId);
    return nativeId && !previous.has(nativeId) && matches(row)
      && (parentId ? row.depth > 0 && id(row.parentExternalId) === parentId && id(row.rootExternalId) === root
        : row.depth === 0 && id(row.rootExternalId) === nativeId);
  });
  if (candidates.length !== 1) return null;
  const externalId = id(candidates[0].externalId);
  url.searchParams.set('comment_id', parentId ? root : externalId);
  if (parentId) url.searchParams.set('reply_comment_id', externalId);
  return { externalId, permalink: url.href };
}

/** Runs in the same isolated document for prepare, inspect, and the single authorized click. */
export async function commentComposer(action, input) {
  const { postUrl, parentId, text, uid, deadline } = input;
  const active = () => Date.now() < deadline && location.origin === 'https://www.facebook.com';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normal = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC').trim();
  const visible = element => Boolean(element.getClientRects().length && !element.closest('[aria-hidden="true"]'));
  const label = (element, pattern) => ['aria-label', 'aria-placeholder', 'title', 'data-placeholder', 'placeholder']
    .some(key => pattern.test(element.getAttribute(key) ?? ''))
    || ['aria-labelledby', 'aria-describedby'].some(key => (element.getAttribute(key) ?? '').split(/\s+/).filter(Boolean)
      .some(id => pattern.test(document.getElementById(id)?.textContent?.trim() ?? '')));
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
  const destPath = dest.pathname.replace(/\/+$/, '');
  const reel = destPath.startsWith('/reel/');
  const reelView = reel ? globalThis.__seedingReelComments : null;
  const rootId = digits(dest.searchParams.get('comment_id'));
  const replyId = digits(dest.searchParams.get('reply_comment_id'));
  const samePost = () => dest.origin === location.origin && destId && destId === isPost(new URL(location.href))
    && (!reel || location.pathname.replace(/\/+$/, '') === destPath);
  const here = () => active() && samePost();
  if (!here() || (replyId || rootId || undefined) !== parentId) return null;
  const ids = href => {
    const url = new URL(href, location.href);
    if (url.origin !== dest.origin || isPost(url) !== destId) return null;
    const root = digits(url.searchParams.get('comment_id'));
    const reply = digits(url.searchParams.get('reply_comment_id'));
    return /^\d+$/.test(root ?? '') && (!reply || /^\d+$/.test(reply)) ? { root, reply, id: reply || root } : null;
  };
  const matches = (scope, selector, check) => [...scope.querySelectorAll(selector)].filter(el => visible(el) && check(el));
  const one = items => items.length === 1 ? items[0] : null;
  const editorName = /^(?:(?:write|leave) (?:a |an |your )?(?:comment|reply)|viết (?:bình luận|phản hồi|câu trả lời)|bình luận dưới tên|comment as|trả lời|reply to)(?:[\s.…]|$)/i;
  const editors = (scope, allowUnlabelled = reel) => matches(scope, '[contenteditable="true"],[contenteditable="plaintext-only"],textarea',
    editor => (editor.isContentEditable || editor instanceof HTMLTextAreaElement)
      && (label(editor, editorName) || (allowUnlabelled && editor.matches('[role="textbox"]'))));
  const editorText = editor => normal(editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText);
  const postScope = () => {
    if (reel) return reelView?.path === destPath && reelView.panel.isConnected && visible(reelView.panel) ? reelView.panel : null;
    const dialogs = matches(document, '[role="dialog"],dialog', dialog => editors(dialog).length > 0);
    if (dialogs.length) return one(dialogs.filter(dialog => !dialogs.some(other => other !== dialog && dialog.contains(other))));
    return one(matches(document, 'main,[role="main"]', () => true));
  };
  const photoPath = /^\/photo(?:\.php)?\/?$/;
  const linkedPostIds = (scope, card = null) => [...new Set(matches(scope, 'a[href]', anchor => {
    const owner = anchor.closest(article);
    return card ? owner === card : !owner || !isComment(owner);
  }).map(anchor => {
    const url = new URL(anchor.href);
    // The photo links inside a text post open its attachments and have independent IDs.
    if (photoPath.test(url.pathname) && !photoPath.test(dest.pathname)) return null;
    return url.origin === dest.origin && !url.searchParams.has('comment_id') && !url.searchParams.has('reply_comment_id')
      ? isPost(url) : null;
  }).filter(Boolean))];
  const rootComposer = (scope, editor) => {
    const card = editor.closest(article);
    if (card && isComment(card)) return false;
    if (scope === reelView?.panel) return !card || !scope.contains(card);
    const linked = card ? linkedPostIds(card, card) : linkedPostIds(scope);
    if (linked.length === 1 && linked[0] === destId) return true;
    const canonical = document.querySelector('link[rel="canonical"],meta[property="og:url"]')?.getAttribute('href')
      ?? document.querySelector('meta[property="og:url"]')?.content;
    if (!card && !linked.length && canonical) {
      const url = new URL(canonical, location.href);
      if (url.origin === dest.origin && isPost(url) === destId) return true;
    }
    // Facebook may render a placeholder timestamp link on a direct post until it is hovered.
    // Require the exact permalink in the address bar, one editor dialog and the named owner in its post header.
    const ownerId = dest.searchParams.get('id');
    if (!here() || !/^\d+$/.test(ownerId ?? '') || !scope.matches('[role="dialog"],dialog')) return false;
    const postHeading = /^(?:bài viết của |post by |.+(?:'|’)s post$)/i;
    const hasPostHeading = label(scope, postHeading) || matches(scope, '[role="heading"],h1,h2,h3,h4',
      node => postHeading.test(normal(node.innerText ?? ''))).length > 0;
    return hasPostHeading && matches(card ?? scope, 'a[href]', link => {
      const author = new URL(link.href);
      return author.origin === dest.origin && author.pathname === '/profile.php' && author.searchParams.get('id') === ownerId
        && !author.searchParams.has('comment_id') && !(link.closest(article) && isComment(link.closest(article)));
    }).length > 0;
  };
  const replyName = /^(?:phản hồi|trả lời|reply)$/i;
  const sendName = /^(?:gửi bình luận|đăng bình luận|gửi phản hồi|đăng phản hồi|bình luận|comment|send comment|post comment|send reply|post reply)$/i;
  const controls = 'button,[role="button"],input[type="submit"]';
  const waitFor = async (fn, timeout = 11000) => {
    const until = Math.min(deadline, Date.now() + timeout);
    do {
      if (!here()) return null;
      const item = fn();
      if (item) return item;
      await pause(160);
    } while (Date.now() < until);
    return null;
  };
  const writeComment = async editor => {
    const matchesDraft = () => editor.isConnected && editorText(editor) === normal(text);
    editor.focus({ preventScroll: true });
    if (document.activeElement !== editor || !here()) return false;
    const plain = editor instanceof HTMLTextAreaElement;
    let selection;
    let caret;
    if (plain) {
      editor.setSelectionRange(0, 0);
    } else {
      selection = window.getSelection();
      if (!selection) return false;
      caret = document.createRange();
      caret.selectNodeContents(editor.querySelector('p') ?? editor);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    document.execCommand('insertText', false, text);
    if (await waitFor(matchesDraft, 850)) return true;
    // Some Lexical editors reject execCommand. Let their input handler observe a
    // mutation inside the original empty paragraph, without replacing the editor.
    if (!here() || document.activeElement !== editor || editorText(editor)) return false;
    const beforeInput = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
    if (editor.dispatchEvent(beforeInput) && !editorText(editor)) {
      if (plain) {
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setValue?.call(editor, text);
      } else if (caret && editor.contains(caret.startContainer)) {
        const container = caret.startContainer;
        const onlyChild = container.firstChild;
        const body = document.createTextNode(text);
        caret.insertNode(body);
        // An empty editor's lone BR is a placeholder. Keeping it would add a newline to the draft.
        if (onlyChild instanceof HTMLBRElement && !onlyChild.nextSibling && onlyChild.previousSibling === body) {
          onlyChild.remove();
        }
        caret.setStartAfter(body);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
      }
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    }
    return Boolean(await waitFor(matchesDraft, 850));
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
    for (let area = editor.parentElement, level = 0; area && scope.contains(area) && level < 12; area = area.parentElement, level++) {
      if (editors(area).length !== 1) return null;
      const buttons = matches(area, controls, btn => {
        const card = btn.closest(article);
        return !(card && isComment(card) && !card.contains(editor))
          && (label(btn, sendName) || sendName.test(normal(btn.innerText ?? '')));
      });
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
      || editorText(saved.editor) !== normal(text)) return null;
    return sendButton(saved.editor, saved.scope);
  };
  if (action === 'prepare') {
    const blocked = issue => ({ ok: false, issue });
    const scope = await waitFor(postScope);
    if (!scope) return blocked(reel ? 'Không tìm thấy khung bình luận của Reel đã mở.'
      : 'Chưa nhận diện được một vùng nhập bình luận trên bài đích.');
    const originalEditors = editors(scope);
    let parent = null;
    if (parentId) {
      parent = await waitFor(() => parentCard(scope));
      const reply = parent && one(own(parent, controls).filter(btn => label(btn, replyName) || replyName.test(normal(btn.innerText ?? ''))));
      if (!reply || !here()) return blocked('Chưa tìm thấy bình luận cha để mở ô trả lời.');
      reply.click();
    }
    const editor = await waitFor(() => one(editors(scope, reel && !parentId).filter(item => {
      if (parentId) return !originalEditors.includes(item);
      return rootComposer(scope, item);
    })));
    if (!editor) {
      return blocked(editors(scope).length
        ? 'Ô nhập đã hiện nhưng chưa đối chiếu được với bài đích.'
        : 'Không nhận diện được nhãn của ô nhập bình luận.');
    }
    if (editorText(editor) || !here()) return blocked('Ô nhập không còn trống hoặc trang đã đổi.');
    if (!await writeComment(editor)) return blocked('Chrome chưa chèn được nội dung bình luận vào đúng ô nhập.');
    globalThis.__seedingComment = { postUrl, parentId, uid, editor, scope, parent };
    if (await waitFor(verify)) return { ok: true };
    return blocked(editorText(editor) === normal(text)
      ? 'Đã điền nội dung nhưng chưa xác minh được nút gửi cùng ô nhập.'
      : 'Nội dung trong ô nhập đã bị thay đổi.');
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
  while (samePost() && scope.isConnected && Date.now() < until) {
    const fromUid = card => own(card, 'a[href]').some(link => {
      const url = new URL(link.href);
      return url.origin === dest.origin && (url.pathname === '/profile.php' && url.searchParams.get('id') === uid
        || /^\/people\/[^/]+\/(\d+)\/?$/.exec(url.pathname)?.[1] === uid);
    });
    const found = commentCards(scope).filter(card => fromUid(card)
      && own(card, '[data-comment-text],[data-ad-preview="message"],[dir="auto"]')
        .some(body => !body.closest('a,button,[role="button"]') && normal(body.innerText) === normal(text)))
      .flatMap(links).filter(link => !existing.has(link.id) && (parentId ? link.root === rootId && link.reply && link.id !== parentId : !link.reply));
    const receipt = one([...new Map(found.map(link => [link.id, link])).values()]);
    if (receipt) {
      dest.searchParams.set('comment_id', receipt.root);
      if (receipt.reply) dest.searchParams.set('reply_comment_id', receipt.reply);
      return { ok: true, receipt: { externalId: receipt.id, permalink: dest.href } };
    }
    await pause(250);
  }
  return { ok: true };
}
