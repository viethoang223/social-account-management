import { buildRadar } from './radar-model.js';
import { customerReadHeader, customerReadPosts, readAboutPanel } from './radar-reader.js';

const facebook = 'https://www.facebook.com';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function sameProfile(base, candidate, about = false) {
  try {
    const url = new URL(candidate);
    if (url.origin !== facebook || url.username || url.password) return false;
    const pathname = url.pathname.replace(/\/+$/, '');
    const id = base.searchParams.get('id');
    if (base.pathname === '/profile.php') {
      return (pathname === '/profile.php' && url.searchParams.get('id') === id)
        || (about === false && /^\/people\/[^/]+\/(\d+)$/.exec(pathname)?.[1] === id);
    }
    return pathname.toLowerCase() === base.pathname.toLowerCase()
      || (about && pathname.toLowerCase().startsWith(base.pathname.toLowerCase() + '/'));
  } catch {
    return false;
  }
}

async function settle(id, base, deadline, about = false) {
  const until = Math.min(deadline, Date.now() + 12_000);
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(id);
    if (tab.status === 'complete' && tab.url && !tab.pendingUrl) {
      if (!sameProfile(base, tab.url, about)) throw new Error('Facebook không mở đúng trang đã giao.');
      await delay(650);
      return;
    }
    await delay(250);
  }
  throw new Error('Trang Facebook chưa sẵn sàng.');
}

async function run(id, func, args = []) {
  const [value] = await chrome.scripting.executeScript({ target: { tabId: id }, func, args });
  return value?.result;
}

/** Reads in an owned tab and returns the same scored schema as the legacy Radar export. */
export async function scanRadar(url, deadline, sameUid) {
  const base = new URL(url);
  if (base.origin !== facebook || !await sameUid()) throw new Error('Profile hoặc địa chỉ Radar không hợp lệ.');
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = await chrome.tabs.create({ url: base.href, active: true });
  if (tab.id === undefined) throw new Error('Không mở được tab Radar.');
  try {
    await settle(tab.id, base, deadline);
    if (!await sameUid()) throw new Error('Phiên đã đổi UID.');
    const header = await run(tab.id, customerReadHeader);
    if (!header || !sameProfile(base, header.url)) throw new Error('Không đọc được hồ sơ đã giao.');
    const posts = await run(tab.id, customerReadPosts, [25, 20, Math.min(deadline, Date.now() + 35_000)]) ?? [];
    if (!await sameUid()) throw new Error('Phiên đã đổi UID.');
    const aboutUrl = new URL(base);
    if (aboutUrl.pathname === '/profile.php') aboutUrl.searchParams.set('sk', 'about');
    else aboutUrl.pathname += '/about';
    const about = [];
    if (Date.now() + 15_000 < deadline) {
      await chrome.tabs.update(tab.id, { url: aboutUrl.href });
      await settle(tab.id, base, deadline, true);
      const panel = await run(tab.id, readAboutPanel);
      if (panel?.sections?.length) about.push(panel);
      const seen = new Set([aboutUrl.href]);
      for (const link of panel?.tabs ?? []) {
        if (Date.now() + 15_000 >= deadline) break;
        if (seen.has(link.href) || !sameProfile(base, link.href, true)) continue;
        seen.add(link.href);
        if (!await sameUid()) throw new Error('Phiên đã đổi UID.');
        await chrome.tabs.update(tab.id, { url: link.href });
        await settle(tab.id, base, deadline, true);
        const part = await run(tab.id, readAboutPanel);
        if (part?.sections?.length) about.push(part);
      }
    }
    if (!await sameUid() || Date.now() >= deadline) throw new Error('Phiên Radar không còn hiệu lực.');
    if (!header.name && !posts.length && !about.length) throw new Error('Trang không trả dữ liệu Radar.');
    return buildRadar({ url, name: header.name, header, posts, about });
  } finally {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current?.url && sameProfile(base, current.url, true)) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      if (current.active && previous?.id && previous.windowId === current.windowId) {
        await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
      }
    }
  }
}
