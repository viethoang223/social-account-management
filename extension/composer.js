/** Runs in a tab opened exclusively for this draft. Keep checks and the click in the same script. */
export async function composer(action, caption, deadline) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalized = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const visible = el => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
  const labels = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText]
    .filter(Boolean).map(normalized);
  const controls = root => Array.from(root.querySelectorAll('button,[role="button"],[role="radio"]')).filter(visible);
  const matching = (root, pattern) => controls(root).filter(el => labels(el).some(label => pattern.test(label)));
  const one = (root, pattern) => {
    const found = matching(root, pattern);
    return found.length === 1 ? found[0] : null;
  };
  const waitFor = async fn => {
    const stop = Math.min(deadline, Date.now() + 4_000);
    do {
      const value = fn();
      if (value) return value;
      await pause(120);
    } while (Date.now() < stop);
    return null;
  };
  const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"],dialog')).filter(visible);
  const editorOf = root => {
    const found = Array.from(root.querySelectorAll('[role="textbox"][contenteditable="true"]')).filter(visible);
    return found.length === 1 ? found[0] : null;
  };
  const rootOf = () => {
    const found = dialogs().filter(root => editorOf(root));
    return found.length === 1 ? found[0] : null;
  };
  const onlyMe = /^(?:(?:Đối tượng|Quyền riêng tư|Audience|Privacy)\s*[:·]\s*)?(?:Chỉ mình tôi|Only me)$/i;
  const audience = /^(?:(?:Đối tượng|Quyền riêng tư|Audience|Privacy)\s*[:·]\s*)?(?:Chỉ mình tôi|Only me|Công khai|Public|Bạn bè|Friends|Tùy chỉnh|Custom|Bạn bè ngoại trừ.*|Friends except.*|Bạn bè cụ thể|Specific friends)$/i;
  const submit = /^(?:Đăng|Post)$/i;
  const privateAudience = root => {
    const button = one(root, audience);
    return button?.matches('button,[role="button"]') && labels(button).some(label => onlyMe.test(label));
  };
  const hasMedia = root => Boolean(root.querySelector('video, [role="progressbar"]')) || controls(root).some(el =>
    labels(el).some(label => /^(?:Xóa ảnh|Xóa video|Remove photo|Remove video|Ảnh\/video, đã thêm \d+|Photo\/video, \d+ added)/i.test(label)));
  // A post can only be submitted from our one dialog with the exact private audience and caption.
  const verified = root => {
    if (!root || dialogs().length !== 1 || hasMedia(root) || !privateAudience(root)) return null;
    const editor = editorOf(root);
    const button = one(root, submit);
    if (!editor || normalized(editor.innerText) !== normalized(caption) || !button
      || button.matches(':disabled,[aria-disabled="true"]')) return null;
    return button;
  };

  if (location.origin !== 'https://www.facebook.com' || /\/(?:login|checkpoint)(?:\/|$)/.test(location.pathname)) return false;
  if (action === 'inspect') return Boolean(verified(rootOf()));
  if (action === 'commit') {
    const button = verified(rootOf());
    if (!button || Date.now() >= deadline) return false;
    button.click();
    return true;
  }
  if (action !== 'prepare' || dialogs().length) return false;
  const open = await waitFor(() => one(document, /^(?:Bạn đang nghĩ gì(?: thế)?[^?]*\?|What(?:'|’)s on your mind[^?]*\?|Tạo bài viết|Create post)$/i));
  if (!open || Date.now() >= deadline) return false;
  open.click();
  const root = await waitFor(rootOf);
  if (!root) return false;
  if (!privateAudience(root)) {
    const audienceButton = one(root, audience);
    if (!audienceButton) return false;
    audienceButton.click();
    const option = await waitFor(() => {
      const elsewhere = dialogs().filter(item => item !== root);
      return elsewhere.length === 1 ? one(elsewhere[0], onlyMe) : null;
    });
    if (!option) return false;
    option.click();
    const audienceDialog = dialogs().find(item => item !== root);
    const save = audienceDialog && one(audienceDialog, /^(?:Xong|Lưu|Done|Save)$/i);
    if (save) save.click();
    if (!await waitFor(() => dialogs().length === 1 && privateAudience(root))) return false;
  }
  const editor = editorOf(root);
  if (!editor || normalized(editor.innerText) || hasMedia(root) || Date.now() >= deadline) return false;
  editor.focus();
  if (!document.execCommand('insertText', false, caption)) return false;
  return Boolean(await waitFor(() => verified(root)));
}
