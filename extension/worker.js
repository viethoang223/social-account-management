import { composer } from './composer.js';
import { commentComposer, findPostedComment } from './comment.js';
import { facebookIdentity } from './facebook-url.js';
import { openReelComments } from './reel-comments.js';
import { scanRadar } from './radar-scan.js';
import { findPublishedText, readCommentThread, readPublicationTimeline, scanResearch } from './research/job.js';
import { closeInstagramResearchTab, instagramAccess, instagramTabKey, scanInstagram, scanInstagramStep } from './research/instagram.js';
import { confirmCreatorPublicPost, readCreatorPublications, readOnCreatorTab, verifyOldPublication } from './research/publication-verify.js';

const facebook = 'https://www.facebook.com';
const pollAlarm = 'seedingsys-poll';
let currentPoll;
let scheduledResearchPoll;
let watchingInstagramThreads = false;
let instagramWakeAfter = 0;

async function observedUid() {
  return (await chrome.cookies.get({ url: facebook, name: 'c_user' }))?.value ?? null;
}

async function api(config, message) {
  const response = await fetch(config.origin + '/extension', {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...message, installationId: config.installationId, uid: await observedUid() }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Máy chủ từ chối kết nối.');
  return result;
}

async function runComposer(target, action, caption, deadline, audience, media, sessionId, part, allowUnverifiedAudience = false) {
  if (deadline <= Date.now()) return null;
  const args = [action, caption, deadline, audience, media ?? null, sessionId ?? null, part ?? null, allowUnverifiedAudience];
  const [value] = await chrome.scripting.executeScript({ target, func: composer, args });
  if (action === 'commit') return value?.result;
  return value?.result ? value.documentId : null;
}

function samePublicationMedia(first, second) {
  if (!first || !second) return !first && !second;
  const a = first.files ?? [first];
  const b = second.files ?? [second];
  return first.format === second.format && a.length === b.length
    && a.every((file, index) => file.mime === b[index].mime && file.size === b[index].size && file.checksum === b[index].checksum);
}

async function discardExpired() {
  const { draft } = await chrome.storage.session.get('draft');
  if (!draft) return;
  if (draft.submitting && !draft.kind) {
    const tab = await chrome.tabs.get(draft.tabId).catch(() => null);
    if (!tab || tab.pinned || tab.url !== draft.url || (tab.pendingUrl && tab.pendingUrl !== draft.url)) {
      await chrome.storage.session.remove('draft');
    } else if (await publicationTabState(draft) === 'finished') {
      await discard(draft);
    }
  } else if (draft.expiry <= Date.now()) await discard(draft);
}

async function discard(draft, publishedUrl) {
  const tab = await chrome.tabs.get(draft.tabId).catch(() => null);
  const published = publishedUrl && facebookIdentity(publishedUrl);
  const locationMatches = url => url === draft.url || (published?.startsWith('post:') && facebookIdentity(url) === published);
  // Close only our original Facebook tab, never a tab navigated somewhere else.
  if (draft.ownedTab !== false && tab && locationMatches(tab.url) && !tab.pinned && (!tab.pendingUrl || locationMatches(tab.pendingUrl))) {
    try { await chrome.tabs.remove(draft.tabId); }
    catch { return false; }
  }
  await chrome.storage.session.remove('draft');
  return true;
}

async function publicationTabState(draft, action = 'submission-state') {
  const target = { tabId: draft.tabId, documentIds: [draft.documentId] };
  const [report] = await chrome.scripting.executeScript({ target, func: composer,
    args: [action, '', 0, draft.audience, draft.media ?? null, draft.sessionId] }).catch(() => []);
  return report?.result;
}

async function settleDraft(command, result) {
  const { draft } = await chrome.storage.session.get('draft');
  if (!draft || draft.sessionId !== command.sessionId) return;
  const outcome = typeof result === 'string' ? result : result.outcome;
  if (outcome === 'prepared') return;
  if (!draft.submitting || draft.kind || result.receipt || await publicationTabState(draft) === 'finished') await discard(draft, result.receipt?.permalink);
}

async function sweepLegacyPublicationTabs() {
  const { draft, legacyPublicationTabsChecked } = await chrome.storage.session.get(['draft', 'legacyPublicationTabsChecked']);
  if (legacyPublicationTabsChecked) return;
  let closed = 0;
  for (const tab of await chrome.tabs.query({ url: 'https://www.facebook.com/*' })) {
    if (!Number.isInteger(tab.id) || tab.id === draft?.tabId || tab.active || tab.pinned || tab.discarded || tab.pendingUrl || tab.status !== 'complete') continue;
    const [proof] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: composer,
      args: ['legacy-published', '', 0] }).catch(() => []);
    if (proof?.result !== 'finished') continue;
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current?.url === tab.url && !current.active && !current.pinned && !current.pendingUrl) {
      try { await chrome.tabs.remove(tab.id); closed++; } catch { /* Keep the tab if Chrome rejects closure. */ }
    }
  }
  await chrome.storage.session.set({ legacyPublicationTabsChecked: { closed } });
}

async function loaded(tabId, deadline) {
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

function ownsFacebookProfile(uid) {
  if (location.origin !== 'https://www.facebook.com') return false;
  return [...document.querySelectorAll('a[href]')].some(link => {
    const url = new URL(link.href);
    return url.origin === location.origin && url.pathname === '/profile.php' && url.searchParams.get('id') === uid
      && url.searchParams.has('fb_profile_edit_entry_point');
  });
}

async function execute(config, command, uid, deadline) {
  let { draft } = await chrome.storage.session.get('draft');
  if (!uid || await observedUid() !== uid || Date.now() >= deadline) return 'blocked';
  const audience = command.audience ?? 'ONLY_ME';
  const sameUid = async () => await observedUid() === uid;
  if (command.action === 'prepare') {
    if (draft?.submitting) return { outcome: 'blocked', issue: 'Tab đăng trước vẫn đang chờ Facebook hoàn tất.' };
    if (draft && !await discard(draft)) return { outcome: 'blocked', issue: 'Chrome chưa đóng được tab của lượt trước.' };
    const url = facebook + '/profile.php?id=' + encodeURIComponent(uid);
    const before = await readPublicationTimeline(uid, Math.min(deadline - 25_000, Date.now() + 14_000), sameUid, command.media ? command.caption : null).catch(() => null);
    const creatorBefore = command.media?.format === 'SINGLE_PHOTO' && audience === 'PUBLIC' && before?.creatorLibrary
      ? await readOnCreatorTab(before.creatorLibrary, Math.min(deadline - 30_000, Date.now() + 8_000), sameUid,
        readCreatorPublications, [uid, null, []]).catch(() => null) : null;
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) return 'blocked';
    draft = { uid, audience, sessionId: command.sessionId, tabId: tab.id, url, expiry: Date.now() + 180_000,
      ...(command.media && { media: command.media }) };
    await chrome.storage.session.set({ draft });
    const page = await loaded(tab.id, Math.min(deadline, Date.now() + 15_000));
    const shown = facebookIdentity(page?.url);
    let owned = shown === 'uid:' + uid || (shown?.startsWith('profile:') && shown === before?.profileIdentity);
    if (!owned && command.media && shown?.startsWith('profile:')) {
      const [evidence] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: ownsFacebookProfile, args: [uid] });
      owned = evidence?.result === true;
    }
    if (!owned || !await sameUid()) return { outcome: 'blocked', issue: 'Không xác nhận được trang cá nhân của đúng UID.' };
    const window = await chrome.windows.get(page.windowId);
    if (!window.focused) await chrome.windows.update(page.windowId, { focused: true });
    draft.url = page.url;
    await chrome.storage.session.set({ draft });
    const target = { tabId: tab.id };
    if (command.media) {
      try {
        const files = command.media.files ?? [command.media];
        for (const [index, file] of files.entries()) {
          for (let offset = 0; offset < file.size; offset += 512 * 1024) {
            if (Date.now() >= deadline) throw Error('Media command expired');
            const part = await api(config, { action: 'read-publish-media', commandId: command.id, offset,
              ...(command.media.files && { fileIndex: index }) });
            if (part.offset !== offset || (part.fileIndex ?? 0) !== index) throw Error('Wrong media part');
            const staged = await runComposer(target, 'stage-media', '', deadline, audience, command.media, command.sessionId, part);
            if (!staged) throw Error('Staging failed');
            target.documentIds = [staged];
          }
        }
      } catch {
        return { outcome: 'blocked', issue: 'Chưa chuyển đủ tệp từ Kho bài viết vào tab đăng.' };
      }
    }
    const documentId = await runComposer(target, 'prepare', command.caption, deadline, audience, command.media, command.sessionId, null, command.allowUnverifiedAudience);
    if (!await sameUid()) return 'blocked';
    if (!documentId) {
      const [details] = await chrome.scripting.executeScript({ target, func: composer,
        args: ['diagnose', command.caption, deadline, audience, command.media ?? null, command.sessionId, null, !!command.allowUnverifiedAudience] });
      return { outcome: 'blocked', ...(typeof details?.result === 'string' && { issue: details.result }) };
    }
    await chrome.storage.session.set({ draft: { ...draft, documentId, before, creatorBefore } });
    return 'prepared';
  }
  if (command.action !== 'commit' || draft?.submitting || draft?.kind === 'comment' || draft?.sessionId !== command.sessionId
    || draft.uid !== uid || draft.audience !== audience || !draft.documentId
    || !samePublicationMedia(draft.media, command.media)) {
    return { outcome: 'blocked', issue: 'Phiên bản nháp hoặc danh sách tệp đã thay đổi trước khi gửi.' };
  }
  const tabTarget = { tabId: draft.tabId, documentIds: [draft.documentId] };
  if (!await runComposer(tabTarget, 'inspect', command.caption, deadline, audience, command.media, command.sessionId, null, command.allowUnverifiedAudience).catch(() => null)) {
    const [details] = await chrome.scripting.executeScript({ target: tabTarget, func: composer,
      args: ['diagnose', command.caption, deadline, audience, command.media ?? null, command.sessionId, null, !!command.allowUnverifiedAudience] }).catch(() => []);
    return { outcome: 'blocked', issue: typeof details?.result === 'string' ? details.result : 'Tài liệu Chrome chứa bản nháp không còn mở.' };
  }
  const requestedAt = Date.now();
  const permit = await api(config, { action: 'authorize', commandId: command.id });
  if (await observedUid() !== uid) return 'blocked';
  // Retain ownership until Facebook has finished, but never use this draft to click again.
  await chrome.storage.session.set({ draft: { ...draft, submitting: true } });
  const clickDeadline = Math.min(deadline, requestedAt + permit.lifetimeMs);
  const clicked = await runComposer(tabTarget, 'commit', command.caption, clickDeadline, audience, command.media, command.sessionId,
    null, command.allowUnverifiedAudience === true && permit.allowUnverifiedAudience === true);
  if (!clicked) return 'blocked';
  const submitted = { outcome: 'clicked', ...(clicked === 'AUDIENCE_UNVERIFIED' && { audienceUnverified: true }) };
  if (command.media) {
    let finished = false;
    while (Date.now() < deadline - 23_000 && await sameUid()) {
      const permalink = await publicationTabState(draft, 'receipt');
      const id = facebookIdentity(permalink);
      if (id?.startsWith('post:') && await sameUid()) return { ...submitted, receipt: { externalId: id.slice(5), permalink } };
      finished = await publicationTabState(draft) === 'finished';
      if (finished) break;
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    // Switching away while the composer is still uploading can interrupt the post.
    if (!finished) return submitted;
  }
  if (draft.before?.creatorLibrary && draft.creatorBefore?.length) {
    const seen = new Set(draft.creatorBefore.map(post => post.id));
    for (let attempt = 0; attempt < 2 && Date.now() < deadline - 14_000; attempt++) {
      const after = await readOnCreatorTab(draft.before.creatorLibrary, Math.min(deadline - 10_000, Date.now() + 12_000), sameUid,
        readCreatorPublications, [uid, command.caption, [...seen]]).catch(() => null);
      const candidates = after?.filter(post => post.captionMatches && !seen.has(post.id)) ?? [];
      if (candidates.length > 1) break;
      if (!candidates.length) continue;
      const { id } = candidates[0];
      const permalink = facebook + '/permalink.php?story_fbid=' + id + '&id=' + uid;
      const verified = await readOnCreatorTab(permalink, Math.min(deadline - 2_000, Date.now() + 9_000), sameUid,
        confirmCreatorPublicPost, [uid, id, command.caption]).catch(() => null);
      if (verified && await sameUid()) return { ...submitted, receipt: { externalId: id, permalink }, verification: 'reopened-post' };
    }
  }
  if (draft.before) {
    for (let attempt = 0; attempt < 2 && Date.now() < deadline - 6_000 && await sameUid(); attempt++) {
      const after = await readPublicationTimeline(uid, Math.min(deadline - 2_000, Date.now() + 18_000), sameUid, command.media ? command.caption : null).catch(() => null);
      const receipt = findPublishedText(uid, command.caption, draft.before, after, Boolean(command.media));
      if (receipt && await sameUid()) return { ...submitted, receipt, verification: 'reopened-post' };
    }
  }
  return submitted;
}

async function executeComment(config, command, uid, deadline) {
  const { postUrl, parentId, knownCommentIds } = command.comment ?? {};
  const identity = facebookIdentity(postUrl);
  const blocked = async issue => {
    await chrome.storage.session.set({ lastCommentIssue: issue });
    return { outcome: 'blocked', issue };
  };
  if (!identity?.startsWith('post:') || !uid || await observedUid() !== uid || deadline <= Date.now()) {
    return blocked('UID, liên kết bài đích hoặc thời hạn không còn khớp lệnh.');
  }
  const reel = new URL(postUrl).pathname.startsWith('/reel/');
  let { draft } = await chrome.storage.session.get('draft');
  const input = { postUrl, parentId, uid, text: command.caption, deadline };
  const sameUid = async () => await observedUid() === uid;
  const run = async (target, action, data = input) => {
    const [view] = await chrome.scripting.executeScript({ target, func: commentComposer, args: [action, data] });
    return view;
  };
  if (command.action === 'comment-prepare') {
    await chrome.storage.session.remove('lastCommentIssue');
    if (draft?.submitting) return blocked('Tab đăng trước vẫn đang chờ Facebook hoàn tất.');
    if (draft && !await discard(draft)) return blocked('Chrome chưa đóng được tab của lượt trước.');
    const before = await readCommentThread(postUrl, Math.min(deadline - 25_000, Date.now() + 14_000), sameUid).catch(() => null);
    const current = parentId ? null : (await chrome.tabs.query({ active: true, url: 'https://www.facebook.com/*' }))
      .find(tab => tab.status === 'complete' && tab.url === postUrl);
    const tab = current ?? await chrome.tabs.create({ url: postUrl, active: true });
    if (tab.id === undefined) return blocked('Chrome không cung cấp được tab bài đích.');
    draft = { kind: 'comment', uid, sessionId: command.sessionId, tabId: tab.id, url: postUrl,
      ownedTab: !current, expiry: Date.now() + 180_000 };
    await chrome.storage.session.set({ draft });
    const page = await loaded(tab.id, Math.min(deadline, Date.now() + 15_000));
    if (facebookIdentity(page?.url) !== identity || await observedUid() !== uid) {
      return blocked('Chrome chưa mở đúng bài đích hoặc phiên đã đổi UID.');
    }
    const window = await chrome.windows.get(page.windowId);
    if (!window.focused) await chrome.windows.update(page.windowId, { focused: true });
    if (!page.active) await chrome.tabs.update(tab.id, { active: true });
    draft.url = page.url;
    await chrome.storage.session.set({ draft });
    const target = { tabId: tab.id };
    if (reel) {
      const [opened] = await chrome.scripting.executeScript({ target, func: openReelComments, args: [postUrl, deadline] });
      if (!opened?.result || !opened.documentId || await observedUid() !== uid) {
        return blocked('Không mở được khung bình luận đúng Reel hoặc phiên đã đổi UID.');
      }
      target.documentIds = [opened.documentId];
    }
    const view = await run(target, 'prepare');
    if (!view?.documentId || !view.result?.ok || await observedUid() !== uid) {
      return blocked(view?.result?.issue ?? 'Phiên bình luận hoặc trang đã thay đổi.');
    }
    await chrome.storage.session.set({ draft: { ...draft, documentId: view.documentId,
      before: before && { comments: before.comments, stoppedEarly: before.stoppedEarly } } });
    return { outcome: 'prepared' };
  }
  if (command.action !== 'comment-commit' || draft?.submitting || draft?.kind !== 'comment' || draft.sessionId !== command.sessionId
    || draft.uid !== uid || !draft.documentId) return blocked('Không còn bản nháp gắn với phiên này.');
  const target = { tabId: draft.tabId, documentIds: [draft.documentId] };
  if (!(await run(target, 'inspect'))?.result?.ok) return blocked('Không còn xác minh được bản nháp và nút gửi.');
  const requestedAt = Date.now();
  const permit = await api(config, { action: 'authorize', commandId: command.id });
  if (await observedUid() !== uid) return blocked('Phiên đã đổi UID trước khi gửi.');
  await chrome.storage.session.set({ draft: { ...draft, submitting: true } });
  const result = (await run(target, 'commit', { ...input, deadline: Math.min(deadline, requestedAt + permit.lifetimeMs) }))?.result;
  if (!result?.ok) return blocked('Không thể bấm nút gửi đã được xác minh.');
  if (result.receipt) return { outcome: 'clicked', receipt: result.receipt };
  if (draft.before && !draft.before.stoppedEarly) {
    for (let attempt = 0; attempt < 2 && Date.now() < deadline - 5_000 && await sameUid(); attempt++) {
      const after = await readCommentThread(postUrl, Math.min(deadline - 2_000, Date.now() + 21_000), sameUid).catch(() => null);
      const receipt = findPostedComment(input, draft.before, after, knownCommentIds);
      if (receipt && await sameUid()) return { outcome: 'clicked', receipt, verification: 'reopened-post' };
    }
  }
  return { outcome: 'clicked' };
}

async function poll() {
  await discardExpired();
  const { config } = await chrome.storage.local.get('config');
  if (!config) return { state: 'DISCONNECTED' };
  const uid = await observedUid();
  const started = Date.now();
  const canReadInstagram = await chrome.permissions.contains(instagramAccess);
  const { instagramLoginRequired, [instagramTabKey]: instagramTab } = await chrome.storage.session.get(['instagramLoginRequired', instagramTabKey]);
  const instagramLoggedIn = canReadInstagram && !instagramLoginRequired
    && Boolean(await chrome.cookies.get({ url: 'https://www.instagram.com/', name: 'sessionid' }));
  const data = await api(config, { action: 'poll', radarProtocol: 1, commentProtocol: 2, researchProtocol: 1, publishProtocol: 2, publishMediaProtocol: 2, publicationVerifyProtocol: 1,
    ...(canReadInstagram && { instagramResearch: 5, instagramLoggedIn, instagramCadenceTrial: 1, instagramCommentsProtocol: 1 }),
    ...(instagramTab && { instagramJobId: instagramTab.id }),
    extensionVersion: chrome.runtime.getManifest().version });
  if (instagramTab && data.instagramJobActive === false) await closeInstagramResearchTab(instagramTab.id);
  if (data.command) {
    const command = data.command;
    const deadline = started + command.lifetimeMs;
    if (command.action === 'publication-verify') {
      const report = await verifyOldPublication(command, uid, deadline, async () => !!uid && await observedUid() === uid).catch(() => null);
      await api(config, { action: 'publication-verify-complete', commandId: command.id, report });
    } else if (command.action === 'radar-scan') {
      const report = await scanRadar(command.url, deadline, async () => !!uid && await observedUid() === uid).catch(() => null);
      await api(config, { action: 'radar-complete', commandId: command.id, report });
    } else if (command.action === 'research-scan') {
      const sameUid = async () => !!uid && await observedUid() === uid;
      const isInstagram = command.url.startsWith('https://www.instagram.com/');
      const instagramReader = command.lease ? scanInstagramStep : scanInstagram;
      const result = isInstagram
        ? await instagramReader(command, deadline, sameUid).catch(() => ({ report: null, issue: 'IG_BROWSER' }))
        : { report: await scanResearch(command, deadline, sameUid).catch(() => null) };
      if (result.issue === 'IG_LOGIN' || result.report?.stopReason === 'IG_LOGIN') {
        await chrome.storage.session.set({ instagramLoginRequired: true });
      }
      if (['RATE_LIMITED', 'SESSION_REQUIRED'].includes(result.report?.instagramThreadCheck?.check)) {
        instagramWakeAfter = Date.now() + 30_000;
      }
      const completion = await api(config, { action: 'research-complete', commandId: command.id, ...(command.lease && { lease: command.lease }), ...result });
      if (command.lease && !result.pending) await closeInstagramResearchTab(command.id);
      if (Number.isFinite(completion.nextResearchPollMs) && completion.nextResearchPollMs >= 0 && completion.nextResearchPollMs <= 30_000) {
        clearTimeout(scheduledResearchPoll);
        scheduledResearchPoll = setTimeout(() => { void pollOnce(); }, Math.max(150, completion.nextResearchPollMs));
      }
    } else if (['comment-prepare', 'comment-commit'].includes(command.action)) {
      const result = await executeComment(config, command, uid, deadline).catch(async () => {
        const issue = 'Chrome hoặc máy chủ từ chối thực thi lệnh bình luận.';
        await chrome.storage.session.set({ lastCommentIssue: issue });
        return { outcome: 'blocked', issue };
      });
      await api(config, { action: 'complete', commandId: command.id, ...result });
      await settleDraft(command, result);
    } else {
      const result = await execute(config, command, uid, deadline).catch(() => 'blocked');
      await api(config, { action: 'complete', commandId: command.id, ...(typeof result === 'string' ? { outcome: result } : result) });
      await settleDraft(command, result);
    }
  } else if (data.state === 'CONNECTED') {
    await sweepLegacyPublicationTabs().catch(() => undefined);
  }
  return { state: data.state, code: data.code };
}

function pollOnce() {
  currentPoll ??= poll().catch(error => ({ state: 'ERROR', message: error.message }))
    .then(async result => {
      await chrome.storage.session.set({ status: { ...result, checkedAt: Date.now() } });
      return result;
    }).finally(() => {
      currentPoll = undefined;
      void watchInstagramThreads();
    });
  return currentPoll;
}

async function watchInstagramThreads() {
  if (watchingInstagramThreads || Date.now() < instagramWakeAfter) return;
  watchingInstagramThreads = true;
  try {
    while (Date.now() >= instagramWakeAfter) {
      if (currentPoll) await currentPoll;
      if (Date.now() < instagramWakeAfter) break;
      const { config } = await chrome.storage.local.get('config');
      const { instagramLoginRequired } = await chrome.storage.session.get('instagramLoginRequired');
      if (!config || instagramLoginRequired || !await chrome.permissions.contains(instagramAccess)
        || !await chrome.cookies.get({ url: 'https://www.instagram.com/', name: 'sessionid' })) break;
      const event = await api(config, { action: 'wait-instagram-thread' });
      if (event.ready) await pollOnce();
    }
  } catch {
    // A lost connection or an older server can use the regular alarm to reconnect.
  } finally {
    watchingInstagramThreads = false;
  }
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (!await chrome.alarms.get(pollAlarm)) await chrome.alarms.create(pollAlarm, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { void initialize().then(pollOnce); });
chrome.runtime.onStartup.addListener(() => { void initialize().then(pollOnce); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === pollAlarm) void pollOnce(); });
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.name === 'sessionid' && /(?:^|\.)instagram\.com$/i.test(cookie.domain)) {
    void chrome.storage.session.remove('instagramLoginRequired');
  }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.url !== chrome.runtime.getURL('popup.html') || message?.action !== 'poll') return;
  void initialize().then(pollOnce).then(reply, error => reply({ state: 'ERROR', message: error.message }));
  return true;
});
