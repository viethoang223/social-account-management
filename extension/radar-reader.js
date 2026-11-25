// FB Desk read-only Radar browser adapter, carried over from caf1130.
// Các hàm chạy TRONG tab Facebook (chrome.scripting.executeScript, func: ...). Mỗi hàm tự chứa, không dùng biến ngoài.
// Chỉ ĐỌC thông tin công khai đang hiện trên trang; không bấm Thích/Theo dõi/Kết bạn, không nhắn tin, không bình luận.

// Đầu trang cá nhân: tên, số người theo dõi, số bạn bè.
export function customerReadHeader() {
  const main = document.querySelector('[role=main]') || document.body;
  const fold = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .toLowerCase();
  const num = (v) => {
    const s = fold(v).trim();
    const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(nghin|trieu|k|n|tr|m)?(?![a-z])/);
    if (!m) return null;
    let n = m[2]
      ? parseFloat(m[1].replace(',', '.'))
      : parseFloat(m[1].replace(/[.,]/g, ''));
    if (/^(k|n|nghin)$/.test(m[2] || '')) n *= 1e3;
    if (/^(tr|trieu|m)$/.test(m[2] || '')) n *= 1e6;
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const leaves = [...main.querySelectorAll('a,span,div')]
    .filter((e) => !e.children.length || e.tagName === 'A')
    .map((e) => (e.innerText || '').trim())
    .filter((t) => t && t.length < 80);
  let followers = null,
    friends = null;
  for (const t of leaves) {
    const f = fold(t);
    let m =
      f.match(/([\d.,]+\s*(?:k|n|nghin|tr|trieu|m)?)\s*nguoi theo doi/) ||
      f.match(/([\d.,]+\s*(?:k|m)?)\s*followers?/);
    if (m && followers == null) followers = num(m[1]);
    m = f.match(
      /([\d.,]+\s*(?:k|n|nghin)?)\s*(?:nguoi )?ban be|([\d.,]+\s*(?:k|n|nghin)?)\s*nguoi ban|([\d.,]+\s*k?)\s*friends?/,
    );
    if (m && friends == null) friends = num(m[1] || m[2] || m[3]);
  }
  const bigName =
    [...main.querySelectorAll('h1,h2,span')]
      .find((e) => {
        const t = (e.innerText || '').trim(),
          r = e.getBoundingClientRect();
        return (
          t &&
          t.length < 80 &&
          !t.includes('\n') &&
          r.top < 900 &&
          parseFloat(getComputedStyle(e).fontSize) >= 24
        );
      })
      ?.innerText?.trim() || '';
  return { name: bigName, followers, friends, url: location.href };
}

// Bài công khai gần đây trên dòng thời gian: chữ, số cảm xúc/bình luận/chia sẻ, tuổi bài (ngày). Cuộn tối đa `rounds` lượt.
export async function customerReadPosts(
  max = 25,
  rounds = 14,
  deadline = Date.now() + 30_000,
) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const fold = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .toLowerCase();
  const norm = (s) =>
    String(s || '')
      .normalize('NFKC')
      .replace(/[\u200b-\u200f\ufeff\u034f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const num = (v) => {
    const s = fold(v).trim();
    const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(nghin|trieu|k|n|tr|m)?(?![a-z])/);
    if (!m) return null;
    let n = m[2]
      ? parseFloat(m[1].replace(',', '.'))
      : parseFloat(m[1].replace(/[.,]/g, ''));
    if (/^(k|n|nghin)$/.test(m[2] || '')) n *= 1e3;
    if (/^(tr|trieu|m)$/.test(m[2] || '')) n *= 1e6;
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const isComment = (e) => {
    for (let p = e; p; p = p.parentElement) {
      if (
        p.matches?.('[role="article"],article') &&
        /^(?:bình luận|phản hồi|đáp lại|comment|reply)|\s(?:đáp lại phản hồi của|replied to)\s/i.test(
          p.getAttribute('aria-label') || '',
        )
      )
        return true;
    }
    return false;
  };
  const expanderOnly = (e) =>
    [...e.querySelectorAll('button,[role="button"]')].every((b) =>
      /^(?:xem thêm|see more|ẩn bớt|see less|thu gọn)$/i.test(
        norm(b.innerText || b.textContent),
      ),
    );
  const textOf = (el) => {
    const c = el.cloneNode(true);
    for (const x of c.querySelectorAll('button,[role="button"],script,style'))
      x.remove();
    for (const im of c.querySelectorAll('img')) im.replaceWith(im.alt || '');
    return norm(c.innerText || c.textContent).replace(
      /\s*(?:xem thêm|see more)$/i,
      '',
    );
  };
  const months = {
    'thang 1': 1,
    'thang 2': 2,
    'thang 3': 3,
    'thang 4': 4,
    'thang 5': 5,
    'thang 6': 6,
    'thang 7': 7,
    'thang 8': 8,
    'thang 9': 9,
    'thang 10': 10,
    'thang 11': 11,
    'thang 12': 12,
  };
  const ageFrom = (t) => {
    const f = fold(norm(t));
    const now = Date.now();
    let m = f.match(/(\d{1,2})\s+thang\s+(\d{1,2}),?\s+(\d{4})/);
    if (m)
      return Math.max(
        0,
        Math.floor((now - new Date(+m[3], +m[2] - 1, +m[1]).getTime()) / 864e5),
      );
    m = f.match(/(\d{1,2})\s+thang\s+(\d{1,2})(?!\d)/);
    if (m) {
      const y = new Date().getFullYear();
      let d = new Date(y, +m[2] - 1, +m[1]);
      if (d.getTime() > now) d = new Date(y - 1, +m[2] - 1, +m[1]);
      return Math.floor((now - d.getTime()) / 864e5);
    }
    m = f.match(/^(\d+)\s*(phut|gio|ngay|tuan|nam|p|h|d|w|y)\b/);
    if (m) {
      const n = +m[1],
        u = m[2];
      return /phut|^p$|gio|^h$/.test(u)
        ? 0
        : /ngay|^d$/.test(u)
          ? n
          : /tuan|^w$/.test(u)
            ? n * 7
            : n * 365;
    }
    if (/^(vua xong|hom nay|just now)/.test(f)) return 0;
    if (/^(hom qua|yesterday)/.test(f)) return 1;
    return null;
  };
  // Trang cá nhân có thể có nhiều khung feed (bài nổi bật + dòng thời gian); mỗi bài là một phần tử con của feed.
  const cards = () => {
    const feeds = [...document.querySelectorAll('[role=main] [role=feed]')];
    const units = feeds
      .flatMap((f) => [...f.children])
      .filter(
        (e) =>
          e.querySelector('a[href]') && (e.innerText || '').trim().length > 0,
      );
    if (units.length) return units;
    const main = document.querySelector('[role=main]');
    return main
      ? [...main.querySelectorAll('[role=article],article')].filter(
          (e) =>
            !isComment(e) &&
            !e.parentElement?.closest('[role=article],article'),
        )
      : [];
  };
  const seen = new Map();
  for (
    let round = 0;
    round < rounds && seen.size < max && Date.now() < deadline;
    round++
  ) {
    for (const card of cards()) {
      if (seen.size >= max || Date.now() >= deadline) break;
      const publicAudience = [
        ...card.querySelectorAll('[aria-label],[title]'),
      ].some(
        (el) =>
          !isComment(el) &&
          [el.getAttribute('aria-label'), el.getAttribute('title')].some(
            (value) => /^(Công khai|Public)$/i.test(norm(value)),
          ),
      );
      if (!publicAudience) continue;
      // Mở "Xem thêm" của caption (không phải của bình luận) để đọc đủ chữ.
      for (const b of [...card.querySelectorAll('[role=button]')]
        .filter(
          (b) =>
            !isComment(b) && /^(xem thêm|see more)$/i.test(norm(b.innerText)),
        )
        .slice(0, 1)) {
        b.click();
        await pause(250);
      }
      const explicit = [
        ...card.querySelectorAll(
          '[data-ad-preview="message"],[data-ad-comet-preview="message"]',
        ),
      ].filter((e) => !isComment(e));
      let text =
        explicit.map(textOf).sort((a, b) => b.length - a.length)[0] || '';
      if (!text) {
        const blocks = [
          ...card.querySelectorAll('div[dir="auto"],span[dir="auto"]'),
        ].filter(
          (e) =>
            !isComment(e) &&
            !e.closest('a,h2,h3,h4,[role=heading]') &&
            expanderOnly(e),
        );
        const outer = blocks.filter(
          (e) => !blocks.some((o) => o !== e && o.contains(e)),
        );
        text =
          outer
            .map(textOf)
            .find((t) => t && t.length > 1 && !/[\u034f]/.test(t)) || '';
      }
      if (
        /^(?:facebook|reels?|thước phim|video|watch|ảnh|photos?)$/i.test(text)
      )
        text = ''; // chữ giao diện, không phải caption
      // Liên kết thời gian: rê chuột để Facebook hiện ngày đầy đủ (chữ thời gian bị trộn ký tự để chống đọc).
      const time = [...card.querySelectorAll('a[href]')].find(
        (a) =>
          !isComment(a) &&
          (a.hasAttribute('aria-describedby') ||
            /\/posts\/|story_fbid=|\/videos\/|\/reel\/|\/photo/.test(a.href)) &&
          a.getBoundingClientRect().width > 0,
      );
      let ageDays = null,
        link = '';
      // Link thời gian ban đầu là "…#?" (giống nhau ở mọi bài); chỉ thành link bài thật sau khi rê chuột.
      if (time) {
        for (const t of ['pointerover', 'mouseover'])
          time.dispatchEvent(
            new (t === 'pointerover' ? PointerEvent : MouseEvent)(t, {
              bubbles: true,
            }),
          );
        await pause(150);
        link = /#/.test(time.href) ? '' : time.href.split('?')[0];
        const tip =
          time.getAttribute('aria-describedby') &&
          document.getElementById(time.getAttribute('aria-describedby'))
            ?.textContent;
        ageDays = ageFrom(
          tip || time.getAttribute('aria-label') || time.innerText,
        );
      }
      const key = link || (text ? 't:' + text.slice(0, 120) : '');
      if (!key || seen.has(key)) continue;
      const labels = [...card.querySelectorAll('[aria-label]')]
        .filter((e) => !isComment(e))
        .map((e) => e.getAttribute('aria-label'));
      // Facebook ghi cảm xúc theo từng loại ("Thích: 42 người", "Yêu thích: 60 người"): cộng các loại; có "Tất cả cảm xúc" thì dùng số đó.
      const kinds = labels
        .map((l) =>
          fold(l).match(
            /^(thich|yeu thich|thuong thuong|haha|wow|buon|phan no|like|love|care|sad|angry)[:：]\s*([\d.,]+\s*(?:k|tr|m)?)\s*(?:nguoi|people)?$/,
          ),
        )
        .filter(Boolean);
      const total = labels
        .map((l) =>
          fold(l).match(
            /^(?:tat ca cam xuc|all reactions)[:：]?\s*([\d.,]+\s*(?:k|tr|m)?)/,
          ),
        )
        .find(Boolean);
      const reactions = total
        ? num(total[1])
        : kinds.length
          ? kinds.reduce((a, m) => a + (num(m[2]) || 0), 0)
          : null;
      const shareLabel = labels
        .map((l) => fold(l).match(/([\d.,]+\s*(?:k|tr|m)?)\s*luot chia se/))
        .find(Boolean);
      const leafs = [...card.querySelectorAll('span,div')]
        .filter((e) => !e.children.length && !isComment(e))
        .map((e) => fold(e.innerText || ''));
      const cm = leafs
        .map((t) => t.match(/^([\d.,]+\s*(?:k|n)?)\s*(?:binh luan|comments?)$/))
        .find(Boolean);
      const sh = leafs
        .map((t) =>
          t.match(/^([\d.,]+\s*(?:k|n)?)\s*(?:luot chia se|shares?)$/),
        )
        .find(Boolean);
      seen.set(key, {
        text: text.slice(0, 3000),
        ageDays,
        reactions,
        comments: cm ? num(cm[1]) : null,
        shares: sh ? num(sh[1]) : shareLabel ? num(shareLabel[1]) : null,
        media: card.querySelector('img[src*="scontent"],video') ? 'có' : '',
      });
    }
    if (seen.size >= max) break;
    window.scrollBy(0, Math.max(700, innerHeight * 0.9));
    await pause(1100);
  }
  return [...seen.values()];
}

// Chép từ Post Research (character.js, đã chạy trên trang thật 23 Dota TV và Nguyễn Yến). Giữ độc lập: không phụ thuộc Post Research.
export function readAboutPanel() {
  const main = document.querySelector('[role=main]');
  if (!main) return null;
  const isSub = (a) => {
    try {
      return (
        /\/(?:directory_[a-z_]+|about_[a-z_]+)\/?$/.test(
          new URL(a.href).pathname,
        ) || /[?&]sk=(?:directory|about)_/.test(a.href)
      );
    } catch {
      return false;
    }
  };
  const sub = [...main.querySelectorAll('a[role=tab][href]')].filter(isSub);
  if (!sub.length) return null;
  let tl = sub[0];
  while (tl && !sub.every((a) => tl.contains(a))) tl = tl.parentElement;
  let panel = [],
    node = tl;
  for (let i = 0; node && node !== main && i < 8; i++) {
    const p = node.parentElement;
    if (!p) break;
    panel = [...p.children].filter(
      (ch) =>
        ch !== node &&
        ch.innerText.trim() &&
        !/^(Giới thiệu|About)$/.test(ch.innerText.trim()),
    );
    if (panel.length) break;
    node = p;
  }
  const own = (e) =>
    ![...e.children].some((c) => c.innerText.trim() === e.innerText.trim());
  const spans = panel
    .flatMap((e) => [...e.querySelectorAll('h2,h3,h4,[role=heading],span')])
    .filter((x) => own(x) && x.innerText.trim());
  const heads = new Set(
    spans
      .filter(
        (x) =>
          parseFloat(getComputedStyle(x).fontSize) >= 17 &&
          Number(getComputedStyle(x).fontWeight) >= 600,
      )
      .map((x) => x.innerText.trim()),
  );
  const small = new Set(
    spans
      .filter((x) => parseFloat(getComputedStyle(x).fontSize) <= 13)
      .map((x) => x.innerText.trim()),
  );
  const sections = [];
  let cur = null;
  for (const raw of panel
    .map((e) => e.innerText)
    .join('\n')
    .split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || /^[·•|]$/.test(line)) continue;
    if (heads.has(line)) {
      if (cur && cur.title === line) continue;
      if (sections.some((s) => s.title === line && s.values.length)) {
        cur = sections.find((s) => s.title === line);
        continue;
      }
      cur = { title: line, values: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: '', values: [] };
      sections.push(cur);
    }
    if (
      small.has(line) &&
      !heads.has(line) &&
      cur.values.length &&
      !cur.values.includes(line)
    ) {
      const last = cur.values.length - 1;
      if (!cur.values[last].includes('(' + line + ')'))
        cur.values[last] += ' (' + line + ')';
      continue;
    }
    if (!cur.values.some((v) => v === line || v.startsWith(line + ' (')))
      cur.values.push(line);
  }
  const selected = sub.find((a) => a.getAttribute('aria-selected') === 'true');
  return {
    path: location.pathname,
    tab: selected?.innerText.trim() || '',
    tabs: sub.map((a) => ({ name: a.innerText.trim(), href: a.href })),
    sections: sections.filter((s) => s.title && s.values.length),
  };
}
