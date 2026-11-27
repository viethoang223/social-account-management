/** Runs in a tab opened exclusively for this draft. Keep checks and the click in the same script. */
export async function composer(action, caption, deadline, expectedAudience = 'ONLY_ME', media, session, part) {
  if (location.origin !== 'https://www.facebook.com' || /\/(?:login|checkpoint)(?:\/|$)/.test(location.pathname)) return false;
  const staged = () => globalThis.__seedingDraftFile;
  const files = media?.files ?? (media ? [media] : []);
  if (['receipt', 'submission-state', 'legacy-published'].includes(action)) {
    const record = globalThis.__seedingPublishReceipt;
    if (!record || (action !== 'legacy-published' && record.session !== session)) return null;
    const receipt = record.links.size === 1 ? [...record.links][0] : null;
    if (action === 'receipt') return receipt;
    const success = /(?:your (?:post|reel) (?:has been|was) (?:published|posted|shared)|(?:bài viết|thước phim) của bạn đã được (?:đăng|chia sẻ))/i;
    const visibleNotice = [...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
      .some(node => node.getClientRects().length && success.test(node.innerText ?? '') && !record.previousNotices?.has(node));
    if (receipt || visibleNotice) return 'finished';
    if (!record.root || Date.now() - record.clickedAt < 12_000) return null;
    const uploading = /\b(?:uploading|publishing|posting|processing)\b|đang (?:đăng|tải lên|xử lý)/i;
    const visibleDialogs = [...document.querySelectorAll('[role="dialog"],dialog,[role="progressbar"]')]
      .filter(node => node.getClientRects().length && !node.closest('[aria-hidden="true"]'));
    return !record.root.getClientRects().length && !visibleDialogs.some(node => uploading.test(node.innerText ?? '')) ? 'finished' : null;
  }
  if (action === 'stage-media') {
    if (!media || !session || !part || Date.now() >= deadline) return false;
    const fileIndex = part.fileIndex ?? 0;
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= files.length) return false;
    if (fileIndex === 0 && part.offset === 0) {
      globalThis.__seedingDraftFile = { session, files: files.map(() => ({ bytes: 0, parts: [] })), attached: false };
    }
    const state = staged();
    const file = state?.files?.[fileIndex];
    if (!file || state.session !== session || file.bytes !== part.offset || state.attached) return false;
    const bytes = Uint8Array.from(atob(part.data), c => c.charCodeAt(0));
    if (!bytes.length || file.bytes + bytes.length > files[fileIndex].size) return false;
    file.parts.push(bytes);
    file.bytes += bytes.length;
    return true;
  }
  const reel = media?.format === 'REEL';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalized = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const visible = el => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
  const labels = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText,
    el instanceof HTMLInputElement ? el.value : '',
    (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent ?? '').join(' ')]
    .filter(Boolean).map(value => normalized(value).replace(/\s+/g, ' '));
  const controls = root => Array.from(root.querySelectorAll(reel
    ? 'button,a[href],[role="link"],[role="button"],[role="radio"]' : 'button,[role="button"],[role="radio"]')).filter(visible);
  const matching = (root, pattern) => {
    const found = controls(root).filter(el => labels(el).some(label => pattern.test(label)));
    return found.filter(el => !found.some(other => other !== el && el.contains(other)));
  };
  const one = (root, pattern) => {
    const found = matching(root, pattern);
    return found.length === 1 ? found[0] : null;
  };
  const actionable = element => element && !element.matches(':disabled')
    && !element.closest('[aria-disabled="true"],[inert]') && getComputedStyle(element).pointerEvents !== 'none' ? element : null;
  const nextPhotoStep = root => {
    const label = /^(?:Tiếp|Tiếp theo|Next)(?:\s+(?:step|bước))?$/i;
    const scope = root.parentElement?.closest('[role="dialog"],dialog') ?? root;
    const builtIn = [...scope.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')]
      .filter(el => visible(el) && labels(el).some(text => label.test(text)));
    const leaves = builtIn.filter(el => !builtIn.some(other => other !== el && el.contains(other)));
    if (leaves.length === 1) return leaves[0];
    if (leaves.length) return null;
    const hits = [...scope.querySelectorAll('span,div')].filter(el => !el.children.length && visible(el)
      && label.test(normalized(el.innerText)));
    const actions = [...new Set(hits.map(el => el.closest('button,[role="button"],[tabindex]')).filter(el => el && scope.contains(el)))];
    return actions.length === 1 ? actions[0] : null;
  };
  const waitFor = async (fn, allotted = 4_000) => {
    const stop = Math.min(deadline, Date.now() + allotted);
    do {
      const value = fn();
      if (value) return value;
      await pause(120);
    } while (Date.now() < stop);
    return null;
  };
  const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"],dialog')).filter(visible);
  const editorOf = root => {
    const visibleFields = Array.from(root.querySelectorAll(reel
      ? 'textarea,input[type="text"],input:not([type]),[contenteditable]:not([contenteditable="false"])'
      : '[role="textbox"][contenteditable="true"],[data-lexical-editor="true"][contenteditable="true"]'))
      .filter(el => visible(el) && !el.closest('[role="search"]'));
    const fields = visibleFields.filter(el => !visibleFields.some(other => other !== el && el.contains(other)));
    const found = fields.filter(el => !reel || labels(el).concat(
        el.getAttribute('placeholder') ?? '', el.getAttribute('aria-placeholder') ?? '', el.getAttribute('aria-description') ?? '',
        (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '),
      ).some(label => /mô tả|chú thích|caption|description|describe (?:your |the )?reel/i.test(label)));
    if (found.length === 1) return found[0];
    const settings = /^(?:Reel settings|Cài đặt thước phim|Cài đặt Reel)$/i;
    if (reel && !found.length && fields.length === 1 && (settings.test(root.getAttribute('aria-label') ?? '')
      || [...root.querySelectorAll('h1,h2,h3,[role="heading"]')].some(el => visible(el) && settings.test(normalized(el.innerText))))) return fields[0];
    return null;
  };
  const reelHeading = /^(?:(?:tạo|chỉnh sửa|chia sẻ|cài đặt) (?:thước phim|reel)|(?:create|edit|share) reel|reel settings)$/i;
  const valueEditor = editor => editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement;
  const editorText = editor => normalized(valueEditor(editor) ? editor.value : editor?.innerText ?? '');
  const editorMatches = editor => {
    if (editorText(editor) === normalized(caption)) return true;
    if (!editor || valueEditor(editor)) return false;
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeName === 'IMG') return node.alt ?? '';
      if (node.nodeName === 'BR') return '\n';
      const contents = [...node.childNodes].map(walk).join('');
      return /^(?:P|DIV|LI)$/.test(node.nodeName) ? (contents === '\n' ? contents : contents + '\n') : contents;
    };
    return normalized([...editor.childNodes].map(walk).join('')) === normalized(caption);
  };
  const previewCaptionMatches = root => !normalized(caption) || normalized(root.innerText).replace(/\s+/g, ' ')
    .includes(normalized(caption).replace(/\s+/g, ' '));
  const rootOf = () => {
    const roots = reel ? [...dialogs(), ...document.querySelectorAll('main,[role="main"]')].filter(root => visible(root) && (
      reelHeading.test(root.getAttribute('aria-label') ?? '') || [...root.querySelectorAll('h1,h2,h3,[role="heading"]')]
        .some(el => visible(el) && reelHeading.test(normalized(el.innerText))))) : dialogs().filter(root => editorOf(root));
    const found = roots.filter(root => !roots.some(other => other !== root && root.contains(other)));
    if (found.length === 1) return found[0];
    const review = staged()?.review;
    return !found.length && review && review.isConnected && visible(review) ? review : null;
  };
  const postTitle = /^(?:Tạo bài viết|Create post|Cài đặt bài viết|Post settings|Xem lại bài viết|Review post)$/i;
  const closeHeader = /^(?:Đóng(?: hộp thoại của công cụ tạo)?|Close(?: (?:the )?(?:composer )?dialog)?|Quay lại|Trở về|Back)$/i;
  const isComposerHeader = (item, root) => root.contains(item) && !editorOf(item)
    && (postTitle.test(normalized(item.getAttribute('aria-label') ?? ''))
      || Array.from(item.querySelectorAll('h1,h2,h3,h4,[role="heading"]')).some(heading =>
        visible(heading) && postTitle.test(normalized(heading.innerText))))
    && controls(item).every(button => labels(button).some(label => closeHeader.test(label)));
  const otherDialogs = root => dialogs().filter(item => item !== root && !item.contains(root) && !isComposerHeader(item, root));
  const supported = { ONLY_ME: /^(?:Chỉ mình tôi|Only me)(?:\s|$)/i, PUBLIC: /^(?:Công khai|Public)(?:\s|$)/i };
  if (!Object.hasOwn(supported, expectedAudience)) return false;
  const expected = supported[expectedAudience];
  const audience = /^(?:Chỉ mình tôi|Only me|Công khai|Public|Bạn bè|Friends|Tùy chỉnh|Custom|Bạn bè ngoại trừ.*|Friends except.*|Bạn bè cụ thể|Specific friends)$/i;
  const submit = reel ? /^(?:Đăng(?: thước phim)?|Chia sẻ thước phim|Post|Publish reel|Share reel)$/i
    : /^(?:Đăng|Đăng bài viết|Đăng ngay|Post|Publish|Post now|Publish now)$/i;
  const audienceLabels = button => labels(button).map(label => label
    .replace(/^(?:(?:Post audience|Đối tượng(?: của bài viết)?|Quyền riêng tư|Audience|Privacy)(?:\s*[:·]\s*|\s+)|Chỉnh sửa quyền riêng tư\.\s*Đang chia sẻ với\s+|Edit privacy\.\s*(?:Currently )?(?:shared|sharing) with\s+)/i, '')
    .replace(/\.$/, ''));
  const audienceButton = root => {
    const found = controls(root).filter(button => button.matches('button,[role="button"]')
      && audienceLabels(button).some(label => audience.test(label) || (reel && /^(?:Chỉ mình tôi|Công khai|Only me|Public|Bạn bè|Friends)\s/i.test(label))));
    const leaves = found.filter(button => !found.some(other => other !== button && button.contains(other)));
    return leaves.length === 1 ? leaves[0] : null;
  };
  const audienceMatches = root => {
    const button = audienceButton(root);
    const choices = button ? audienceLabels(button).filter(label => audience.test(label)
      || (reel && /^(?:Chỉ mình tôi|Công khai|Only me|Public|Bạn bè|Friends)\s/i.test(label))) : [];
    return choices.length > 0 && choices.every(label => expected.test(label));
  };
  const hasMedia = root => [...root.querySelectorAll('video, [role="progressbar"]')].some(visible) || controls(root).some(el =>
    labels(el).some(label => /^(?:Xóa ảnh|Xóa video|Remove photo|Remove video|Ảnh\/video, đã thêm \d+|Photo\/video, \d+ added)/i.test(label)));
  const removePhoto = /^(?:Xóa ảnh|Gỡ ảnh|Xóa ảnh\/video|Xóa tệp đính kèm|Remove photo|Remove image|Remove photo\/video|Remove post attachment)(?:\s|$)/i;
  const hasPreview = root => {
    if ([...root.querySelectorAll('[role="progressbar"]')].some(visible)
      || /đang tải lên|đang xử lý video|uploading|processing video/i.test(root.innerText)) return false;
    if (reel) {
      const videos = [...root.querySelectorAll('video')].filter(visible);
      return videos.length === 1 || (!videos.length && [...root.querySelectorAll('canvas')].filter(visible).length === 1
        && !!one(root, /^(?:Phát video|Tạm dừng video|Play video|Pause video)$/i));
    }
    if (files.length > 1 || media?.format === 'VIDEO') {
      const before = staged()?.baseline ?? new Set();
      const large = el => visible(el) && !el.closest('[contenteditable]')
        && el.getBoundingClientRect().width >= 48 && el.getBoundingClientRect().height >= 48;
      const videos = [...root.querySelectorAll('video')].filter(large);
      const isVideoPoster = image => {
        const box = image.getBoundingClientRect();
        return videos.some(video => {
          const preview = video.getBoundingClientRect();
          const width = Math.min(box.right, preview.right) - Math.max(box.left, preview.left);
          const height = Math.min(box.bottom, preview.bottom) - Math.max(box.top, preview.top);
          return width > 0 && height > 0 && width * height >= box.width * box.height * 0.8;
        });
      };
      const images = [...root.querySelectorAll('img')].filter(el => {
        const src = el.currentSrc || el.src;
        return large(el) && src && !before.has(src) && el.complete && el.naturalWidth >= 32
          && !isVideoPoster(el);
      });
      const uniqueImages = new Set(images.map(el => el.currentSrc || el.src)).size;
      const rendered = uniqueImages + videos.length;
      const overlays = [...root.querySelectorAll('span,div')].filter(el => !el.children.length && visible(el)).flatMap(el => {
        const count = /^\+\s?(\d{1,2})$/.exec(normalized(el.innerText))?.[1];
        if (!count) return [];
        const box = el.getBoundingClientRect();
        return images.some(image => {
          const area = image.getBoundingClientRect();
          return box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top;
        }) ? [Number(count)] : [];
      });
      const hidden = Math.max(0, ...overlays.map(count => count - 1));
      const countLabels = [...root.querySelectorAll('[aria-label],button,[role="button"]')].filter(visible).flatMap(el => labels(el))
        .flatMap(label => {
          const count = /^(?:(?:edit all|sửa tất cả|chỉnh sửa tất cả)\s*\((\d{1,2})\)|(?:photo\/video|ảnh\/video)[,:]?\s*(?:added|đã thêm)\s*(\d{1,2})|(\d{1,2})\s+(?:photos|images|items|ảnh|tệp))$/i.exec(label);
          return count ? [Number(count[1] ?? count[2] ?? count[3])] : [];
        });
      const wantedVideos = files.filter(file => file.mime === 'video/mp4').length;
      const wantedImages = files.length - wantedVideos;
      const errored = [...root.querySelectorAll('[role="alert"]')].some(el => visible(el) && /failed|error|không thể|lỗi/i.test(el.innerText));
      const total = Math.max(rendered + hidden, ...countLabels);
      return !errored && total === files.length && rendered > 0
        && Math.max(0, wantedVideos - videos.length) + Math.max(0, wantedImages - uniqueImages) <= hidden
        && (videos.length >= wantedVideos || (wantedVideos > 0 && videos.length > 0 && hidden >= wantedVideos - videos.length))
        && (uniqueImages >= wantedImages || hidden >= wantedImages - uniqueImages);
    }
    const photos = [...root.querySelectorAll('img')].filter(el => visible(el) && !el.closest('[contenteditable]')
      && el.getBoundingClientRect().width >= 48 && (/^(?:blob:|data:image\/)/.test(el.currentSrc || el.src)
        || /^(?:post\.(?:jpg|png|webp|gif))$/i.test(el.alt ?? '')
        || !!el.closest('[aria-label="Attached media"],[aria-label="Post preview"],[aria-label="Xem trước bài viết"],[aria-label="Tệp đính kèm"]')));
    if (!photos.length && staged()?.review === root && matching(root, /^post\.(?:jpg|png|webp|gif)$/i).length === 1) return true;
    return photos.length === 1 || (!photos.length && matching(root, removePhoto).length === 1 && !root.querySelector('video'));
  };
  const attach = async root => {
    const fileState = staged();
    if (!fileState || fileState.session !== session || fileState.attached
      || !files.every((file, index) => fileState.files?.[index]?.bytes === file.size)) return false;
    fileState.baseline = new Set([...root.querySelectorAll('img')].map(el => el.currentSrc || el.src));
    const selectInput = () => {
      const inputs = [...root.querySelectorAll('input[type="file"]')].filter(input => !input.disabled && (files.length === 1 || input.multiple));
      const supportedInputs = inputs.filter(input => files.every(file => !input.accept || input.accept.includes(file.mime.split('/')[0])));
      return supportedInputs.length === 1 ? supportedInputs[0] : inputs.length === 1 ? inputs[0] : null;
    };
    let input = selectInput();
    if (!input && !reel) one(root, /^(?:Ảnh\/video|Thêm ảnh\/video|Photo\/video|Add photos\/videos)$/i)?.click();
    const reelDrop = !input && reel ? one(root, /^(?:Add video or drag and drop|Thêm video hoặc kéo và thả)$/i) : null;
    if (!input && !reelDrop) input = await waitFor(selectInput);
    if (!input && !reelDrop) return false;
    const transfer = new DataTransfer();
    for (const [index, spec] of files.entries()) {
      const suffix = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4' }[spec.mime];
      if (!suffix) return false;
      const file = new File(fileState.files[index].parts, (files.length === 1 ? 'post' : `post-${index + 1}`) + '.' + suffix, { type: spec.mime });
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== spec.checksum || Date.now() >= deadline) return false;
      transfer.items.add(file);
    }
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      for (const event of ['dragenter', 'dragover', 'drop']) {
        reelDrop.dispatchEvent(new DragEvent(event, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }
    }
    Object.assign(fileState, { attached: true, checksums: files.map(file => file.checksum), files: [] });
    return true;
  };
  // The single authorized click is tied to the exact intended audience and caption.
  const captionMatches = root => {
    const editor = editorOf(root);
    if (editor) return editorMatches(editor);
    return staged()?.review === root && previewCaptionMatches(root);
  };
  const verified = root => {
    if (!root || otherDialogs(root).length || !audienceMatches(root)) return null;
    if (media ? (staged()?.session !== session || !staged()?.attached || staged().checksums.length !== files.length
      || files.some((file, index) => staged().checksums[index] !== file.checksum) || !hasPreview(root)) : hasMedia(root)) return null;
    const button = one(root, submit);
    return captionMatches(root) ? actionable(button) : null;
  };

  if (action === 'diagnose') {
    if (media && staged()?.diagnostic) return staged().diagnostic;
    const root = rootOf();
    if (!root) return 'Không xác định được một hộp soạn bài.';
    if (otherDialogs(root).length) return 'Vẫn còn một hộp thoại khác trên bài nháp.';
    if (!audienceMatches(root)) return 'Chưa xác nhận được đối tượng xem đã yêu cầu.';
    if (!captionMatches(root)) return 'Nội dung trong ô soạn khác bản đã duyệt.';
    if (media && !hasPreview(root)) return 'Facebook chưa hiện đúng ảnh hoặc Reel trong bản xem trước.';
    return 'Không xác nhận được nút Đăng.';
  }
  if (action === 'inspect') return Boolean(verified(rootOf()));
  if (action === 'commit') {
    const root = rootOf();
    const button = verified(root);
    if (!button || Date.now() >= deadline) return false;
    if (session) {
      const notices = () => [...document.querySelectorAll('[role="status"] a[href],[role="alert"] a[href],[aria-live] a[href]')]
        .filter(link => visible(link) && !link.closest('article,[role="article"]') && labels(link).some(label =>
          /^(?:View|View reel|View post|View your post|See post|Xem|Xem thước phim|Xem bài viết|Xem bài viết của bạn)$/i.test(label)))
        .map(link => link.href).filter(raw => {
          const url = new URL(raw);
          return url.origin === location.origin && (/\/(?:posts|reel|videos)\/\w+\/?$/.test(url.pathname)
            || (['/story.php', '/permalink.php'].includes(url.pathname) && /^\w+$/.test(url.searchParams.get('story_fbid') ?? '')));
        });
      const prior = new Set(notices());
      const links = new Set();
      const collect = () => { for (const url of notices()) if (!prior.has(url)) links.add(url); };
      const observer = new MutationObserver(collect);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'aria-label'] });
      const previousNotices = new Set([...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
        .filter(node => /published|posted|shared|đã được đăng|đã được chia sẻ/i.test(node.innerText ?? '')));
      globalThis.__seedingPublishReceipt = { session, links, root, previousNotices, clickedAt: Date.now() };
      setTimeout(() => observer.disconnect(), 15_000);
    }
    button.click();
    return true;
  }
  if (action !== 'prepare' || dialogs().length) return false;
  let open = await waitFor(() => one(document, reel ? /^(?:Tạo (?:thước phim|reel)|Create reel)$/i
    : /^(?:Bạn đang nghĩ gì(?: thế)?[^?]*\?|What(?:'|’)s on your mind[^?]*\?|Tạo bài viết|Create post)$/i));
  if (!open && reel) {
    one(document, /^(?:Facebook menu|Menu trên Facebook|Menu)$/i)?.click();
    open = await waitFor(() => one(document, /^(?:Thước phim|Reel)$/i));
  }
  if (!open || Date.now() >= deadline) {
    if (reel && staged()) staged().diagnostic = 'Không tìm thấy mục tạo Reel trên trang cá nhân hoặc trong menu Facebook.';
    return false;
  }
  open.click();
  let root = await waitFor(rootOf);
  if (!root) {
    if (reel && staged()) staged().diagnostic = 'Đã mở mục Reel nhưng Facebook chưa hiện khung tạo Reel.';
    return false;
  }
  if (reel) {
    if (!await attach(root)) {
      if (staged()) staged().diagnostic = 'Khung Reel chưa nhận được tệp MP4 từ Kho bài viết.';
      return false;
    }
    for (let i = 0; i < 2 && !editorOf(root); i++) {
      const next = await waitFor(() => {
        root = rootOf() ?? root;
        return actionable(one(root, /^(?:Tiếp|Tiếp theo|Next)$/i));
      }, 9_000);
      if (!next) {
        if (staged()) staged().diagnostic = 'Màn Reel chưa hiện ô caption hoặc một nút Tiếp theo khả dụng.';
        return false;
      }
      next.click();
      root = await waitFor(() => rootOf()) ?? root;
      if (!editorOf(root)) await pause(500);
    }
    root = await waitFor(() => {
      const current = rootOf();
      return current && editorOf(current) && current;
    }, 8_000);
    if (!root) return false;
  }
  if (!audienceMatches(root)) {
    const button = audienceButton(root);
    if (!button) return false;
    button.click();
    const picker = () => {
      const label = /^(?:Select audience|Post audience|Reel audience|Who can see your (?:post|reel)\?|Chọn đối tượng|Đối tượng của (?:bài viết|thước phim)|Ai có thể xem (?:bài viết|thước phim) của bạn\?)$/i;
      const named = dialogs().filter(panel => label.test(normalized(panel.getAttribute('aria-label') ?? ''))
        || [...panel.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].some(el => visible(el) && label.test(normalized(el.innerText))));
      const candidates = named.length ? named : otherDialogs(root);
      const innermost = candidates.filter(panel => !candidates.some(other => other !== panel && panel.contains(other)));
      return innermost.length === 1 ? innermost[0] : null;
    };
    const audienceOption = () => {
      const panel = picker();
      if (!panel) return null;
      const words = [...panel.querySelectorAll('span,div')].filter(item => visible(item) && item.children.length === 0
        && /^(?:Public|Công khai|Only me|Chỉ mình tôi)$/i.test(normalized(item.innerText)) && expected.test(normalized(item.innerText)));
      const choices = words.map(word => ({ word, radio: word.closest('[role="radio"],label') })).filter(item => item.radio);
      if (choices.length === 1) return choices[0];
      const candidates = matching(panel, expected);
      const radios = [...panel.querySelectorAll('[role="radio"],input[type="radio"]')]
        .filter(item => visible(item) && labels(item).some(label => expected.test(label)));
      const options = radios.length ? radios : candidates;
      return options.length === 1 ? { word: options[0], radio: options[0] } : null;
    };
    const option = await waitFor(audienceOption);
    if (!option) {
      if (media && staged()) staged().diagnostic = 'Hộp đối tượng chưa hiện một lựa chọn Công khai xác định.';
      return false;
    }
    const checked = item => item?.radio instanceof HTMLInputElement ? item.radio.checked : item?.radio.getAttribute('aria-checked');
    option.word.scrollIntoView({ block: 'nearest' });
    option.word.click();
    await pause(420);
    const selected = audienceOption();
    if (checked(selected) === 'false' || checked(selected) === false) {
      const control = selected.radio;
      control.focus({ preventScroll: true });
      control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
      control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      control.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
      control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      control.click();
      await waitFor(() => {
        const state = checked(audienceOption());
        return state === 'true' || state === true || !picker();
      }, 2500);
    }
    const save = await waitFor(() => {
      const panel = picker();
      return panel && actionable(one(panel, /^(?:Xong|Lưu|Done|Save)$/i));
    }, 4000);
    if (save) save.click();
    root = await waitFor(() => {
      const found = rootOf();
      return found && !otherDialogs(found).length && audienceMatches(found) && found;
    }, 8000);
    if (!root) {
      if (media && staged()) staged().diagnostic = 'Facebook chưa trả lại bản nháp với đối tượng Công khai sau khi xác nhận lựa chọn.';
      return false;
    }
  }
  const editor = editorOf(root);
  if (!editor || editorText(editor) || (!reel && hasMedia(root)) || Date.now() >= deadline) return false;
  if (valueEditor(editor)) {
    if (editor instanceof HTMLInputElement && /\r|\n/.test(caption)) return false;
    const proto = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, caption);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return Boolean(await waitFor(() => verified(rootOf()), 30_000));
  }
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection || document.activeElement !== editor) return false;
  const container = editor.querySelector('p') ?? editor;
  const range = document.createRange();
  range.selectNodeContents(container);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  if (media && /\r?\n/.test(caption)) {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', caption);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    await pause(350);
    if (!editorMatches(editor)) {
      if (!editor.isConnected || document.activeElement !== editor || Date.now() >= deadline) return false;
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      if (editorText(editor)) document.execCommand('delete');
      else selection.collapseToStart();
      const lineBreak = editor.getAttribute('contenteditable') === 'plaintext-only' ? 'insertLineBreak' : 'insertParagraph';
      for (const [index, line] of caption.replace(/\r\n?/g, '\n').split('\n').entries()) {
        if (index) document.execCommand(lineBreak);
        if (line) document.execCommand('insertText', false, line);
      }
    }
  } else if (!document.execCommand('insertText', false, caption)) {
    await pause(500);
    if (caption && !normalized(editor.innerText)) {
      if (Date.now() >= deadline || document.activeElement !== editor || !editor.contains(range.startContainer)) return false;
      const placeholder = container.firstChild;
      const body = document.createTextNode(caption);
      range.insertNode(body);
      if (placeholder instanceof HTMLBRElement && !placeholder.nextSibling && placeholder.previousSibling === body) placeholder.remove();
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: caption, bubbles: true }));
    }
  }
  if (media && !reel && !await attach(root)) return false;
  if (media && !reel && !verified(root)) {
    const path = await waitFor(() => {
      if (verified(root)) return { direct: true };
      if (!captionMatches(root) || !audienceMatches(root) || !hasPreview(root)) return null;
      const next = actionable(nextPhotoStep(root));
      return next ? { next } : null;
    }, 21_000);
    if (path?.direct) return true;
    if (!path?.next) {
      staged().diagnostic = `Bước Tiếp theo chưa sẵn sàng (caption ${captionMatches(root)}, đối tượng ${audienceMatches(root)}, ảnh ${hasPreview(root)}, nút ${!!nextPhotoStep(root)}).`;
      return false;
    }
    staged().diagnostic = 'Đã bấm Tiếp theo nhưng chưa xác nhận được ảnh, caption và Công khai ở màn Post settings.';
    path.next.click();
    const review = await waitFor(() => {
      const matches = dialogs().filter(panel => /(?:post settings|review post|cài đặt bài viết|xem lại bài viết|create post|tạo bài viết)/i
        .test((panel.getAttribute('aria-label') ?? '') + ' ' + panel.innerText) && !!one(panel, submit)
        && audienceMatches(panel) && previewCaptionMatches(panel));
      const innermost = matches.filter(panel => !matches.some(other => other !== panel && panel.contains(other)));
      return innermost.length === 1 ? innermost[0] : null;
    }, 16_000);
    if (!review || staged()?.session !== session) return false;
    staged().review = review;
    staged().diagnostic = 'Post settings đã hiện đúng caption và Công khai nhưng chưa xác nhận được ảnh hoặc nút Đăng.';
  }
  return Boolean(await waitFor(() => verified(rootOf()), media ? 30_000 : 4_000));
}
