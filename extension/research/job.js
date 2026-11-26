import { facebookIdentity } from '../facebook-url.js';
import { openReelComments } from '../reel-comments.js';
import { readResearch } from './reader.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const trim = (value, limit) => [...String(value ?? '')].slice(0, limit).join('').trim();
const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).length;
const nativeId = value => /^[\w=+/-]{1,150}$/.test(value ?? '') ? value : null;

function publicMedia(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.href.length <= 2048
      && /(?:^|\.)(?:facebook\.com|fbcdn\.net|fbsbx\.com)$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function facebookLink(value) {
  return String(value ?? '').length <= 500 && facebookIdentity(value) ? value : null;
}

function reportFor(kind, value, limit) {
  const list = (items, map, max) => [...new Set((items ?? []).map(map).filter(Boolean))].slice(0, max);
  if (kind === 'RESEARCH_PROFILE') {
    const rows = value?.rows?.flatMap(row => {
      const url = facebookLink(row.url);
      if (!url || !facebookIdentity(url).startsWith('post:')) return [];
      return [{ url, title: trim(row.title, 140), body: trim(row.body, 350), captionPartial: !!row.captionPartial || trim(row.body, 350) !== row.body }];
    }).slice(0, limit);
    return rows ? { kind, rows, partial: !value.ended && rows.length < limit } : null;
  }
  if (!value || !(value.body || value.author || value.comments?.length || value.images?.length || value.video)) return null;
  const body = trim(value.body, 8000);
  const comments = [];
  let partial = !!value.stoppedEarly || value.comments.length > 40;
  for (const row of value.comments.slice(0, 40)) {
    const text = trim(row.text, 4000);
    if (!text || text !== row.text || row.depth > 24) { partial = true; break; }
    const entry = { externalId: nativeId(row.externalId), parentExternalId: nativeId(row.parentExternalId),
      name: trim(row.originalName || row.name, 160), text, depth: row.depth };
    // Keep complete comments and parent order within the dashboard proxy's body limit.
    if (byteLength([...comments, entry]) > 18_000) { partial = true; break; }
    comments.push(entry);
  }
  const mediaLinks = list([...value.images, value.videoURL, value.gallery, ...value.videoLinks], publicMedia, 8);
  while (byteLength(mediaLinks) > 8000) mediaLinks.pop();
  return { kind, body, captionPartial: !!value.captionPartial || body !== value.body,
    author: trim(value.author, 160), authorUrl: facebookLink(value.authorURL), location: trim(value.location, 160),
    mediaLinks, hasMedia: Boolean(value.images.length || value.gallery || value.video || value.more),
    mediaPartial: !!value.more || value.images.length + value.videoLinks.length > mediaLinks.length,
    sourceKind: value.sourceKind, comments, partial };
}

async function readOnFacebook(command, deadline, sameUid, fail, fresh = false) {
  const { url, kind, limit } = command;
  const identity = facebookIdentity(url);
  if (!identity || identity.startsWith('post:') !== (kind === 'RESEARCH_POST') || Date.now() >= deadline || !await sameUid()) {
    return fail('URL, UID hoặc thời hạn của lượt đọc không khớp.');
  }
  let tab, openedTab = false, stage = 'Mở tab Facebook';
  try {
    if (!fresh) {
      const openTabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
      tab = openTabs.find(item => item.active && item.status === 'complete' && facebookIdentity(item.url) === identity);
    }
    if (!tab) {
      tab = await chrome.tabs.create({ url, active: kind === 'RESEARCH_POST' });
      openedTab = true;
    }
    if (tab.id === undefined) return fail('Chrome không cung cấp tab cho lượt đọc.');
    const until = Math.min(deadline, Date.now() + 15_000);
    for (;;) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete' && !current.pendingUrl && facebookIdentity(current.url) === identity) break;
      if (Date.now() >= until) {
        return fail(facebookIdentity(current.url) === identity
          ? 'Tab mở đúng bài nhưng tải quá thời gian.'
          : 'Tab Facebook không mở được đúng link đã giao.');
      }
      await delay(250);
    }
    if (!await sameUid()) return fail('UID đổi trước khi đọc.');
    const target = { tabId: tab.id };
    if (new URL(url).pathname.startsWith('/reel/')) {
      stage = 'Mở khung bình luận của Reel';
      const [opened] = await chrome.scripting.executeScript({ target, func: openReelComments, args: [url, deadline] });
      if (!opened?.result || !opened.documentId) return fail('Chưa mở được khung bình luận của đúng Reel.');
      if (!await sameUid()) return fail('UID đổi sau khi mở khung bình luận của Reel.');
      target.documentIds = [opened.documentId];
    }
    stage = 'Đọc nội dung trang';
    const [read] = await chrome.scripting.executeScript({
      target, func: readResearch,
      args: [kind === 'RESEARCH_POST' ? 'post' : 'profile', url, limit, deadline],
    });
    if (!read?.result || read.result.issue) return fail(read?.result?.issue ?? 'Trình đọc chưa nhận diện được nội dung trên trang đã mở.');
    if (Date.now() >= deadline || facebookIdentity(read.result.url) !== identity || !await sameUid()) {
      return fail('Phiên đọc hoặc URL thay đổi trong lúc xử lý.');
    }
    return read.result.value;
  } catch {
    return fail(stage + ' không thành công.');
  } finally {
    if (openedTab && tab?.id !== undefined) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (facebookIdentity(current?.url) === identity) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

export async function scanResearch(command, deadline, sameUid) {
  await chrome.storage.session.remove('lastResearchIssue');
  const fail = async reason => {
    await chrome.storage.session.set({ lastResearchIssue: reason });
    return null;
  };
  const value = await readOnFacebook(command, deadline, sameUid, fail);
  if (!value) return null;
  const report = reportFor(command.kind, value, command.limit);
  return report && byteLength(report) <= 62_000 ? { ...report, url: command.url } : fail('Kết quả rỗng hoặc vượt giới hạn.');
}

export function readCommentThread(postUrl, deadline, sameUid) {
  const url = new URL(postUrl);
  url.searchParams.delete('comment_id');
  url.searchParams.delete('reply_comment_id');
  return readOnFacebook({ url: url.href, kind: 'RESEARCH_POST', limit: 20 }, deadline, sameUid, () => null, true);
}
