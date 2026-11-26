import { composer } from './composer.js';
import { commentComposer } from './comment.js';
import { facebookIdentity } from './facebook-url.js';
import { openReelComments } from './reel-comments.js';
import { scanRadar } from './radar-scan.js';
import { scanResearch } from './research/job.js';

const facebook = 'https://www.facebook.com';
const pollAlarm = 'seedingsys-poll';
let currentPoll;

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

async function runComposer(target, action, caption, deadline) {
  if (deadline <= Date.now()) return null;
  const [value] = await chrome.scripting.executeScript({ target, func: composer, args: [action, caption, deadline] });
  return value?.result ? value.documentId : null;
}

async function discardExpired() {
  const { draft } = await chrome.storage.session.get('draft');
  if (draft && draft.expiry <= Date.now()) await discard(draft);
}

async function discard(draft) {
  await chrome.storage.session.remove('draft');
  const tab = await chrome.tabs.get(draft.tabId).catch(() => null);
  // Close only our original Facebook tab, never a tab navigated somewhere else.
  if (tab?.url === draft.url) await chrome.tabs.remove(draft.tabId).catch(() => {});
}

async function loaded(tabId, deadline) {
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function execute(config, command, uid, deadline) {
  let { draft } = await chrome.storage.session.get('draft');
  if (!uid || await observedUid() !== uid || Date.now() >= deadline) return 'blocked';
  if (command.action === 'prepare') {
    if (draft) await discard(draft);
    const url = facebook + '/profile.php?id=' + encodeURIComponent(uid);
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) return 'blocked';
    draft = { uid, sessionId: command.sessionId, tabId: tab.id, url, expiry: Date.now() + 180_000 };
    await chrome.storage.session.set({ draft });
    const page = await loaded(tab.id, Math.min(deadline, Date.now() + 15_000));
    if (!page?.url?.startsWith(facebook + '/') || await observedUid() !== uid) return 'blocked';
    draft.url = page.url;
    await chrome.storage.session.set({ draft });
    const documentId = await runComposer({ tabId: tab.id }, 'prepare', command.caption, deadline);
    if (!documentId || await observedUid() !== uid) return 'blocked';
    await chrome.storage.session.set({ draft: { ...draft, documentId } });
    return 'prepared';
  }
  if (command.action !== 'commit' || draft?.kind === 'comment' || draft?.sessionId !== command.sessionId
    || draft.uid !== uid || !draft.documentId) return 'blocked';
  const tabTarget = { tabId: draft.tabId, documentIds: [draft.documentId] };
  if (!await runComposer(tabTarget, 'inspect', command.caption, deadline)) return 'blocked';
  const requestedAt = Date.now();
  const permit = await api(config, { action: 'authorize', commandId: command.id });
  if (await observedUid() !== uid) return 'blocked';
  // Clear the draft handle before dispatching the single click. The tab remains for verification.
  await chrome.storage.session.remove('draft');
  const clickDeadline = Math.min(deadline, requestedAt + permit.lifetimeMs);
  if (!await runComposer(tabTarget, 'commit', command.caption, clickDeadline)) return 'blocked';
  return 'clicked';
}

async function executeComment(config, command, uid, deadline) {
  const { postUrl, parentId } = command.comment ?? {};
  const identity = facebookIdentity(postUrl);
  if (!identity?.startsWith('post:') || !uid || await observedUid() !== uid || deadline <= Date.now()) return { outcome: 'blocked' };
  const reel = new URL(postUrl).pathname.startsWith('/reel/');
  let { draft } = await chrome.storage.session.get('draft');
  const input = { postUrl, parentId, uid, text: command.caption, deadline };
  const run = async (target, action, data = input) => {
    const [view] = await chrome.scripting.executeScript({ target, func: commentComposer, args: [action, data] });
    return view;
  };
  if (command.action === 'comment-prepare') {
    await chrome.storage.session.remove('commentPrepareError');
    if (draft) await discard(draft);
    // Facebook's Reel editor does not retain text entered while its tab is inactive.
    const tab = await chrome.tabs.create({ url: postUrl, active: reel });
    if (tab.id === undefined) return { outcome: 'blocked' };
    draft = { kind: 'comment', uid, sessionId: command.sessionId, tabId: tab.id, url: postUrl, expiry: Date.now() + 180_000 };
    await chrome.storage.session.set({ draft });
    const page = await loaded(tab.id, Math.min(deadline, Date.now() + 15_000));
    if (facebookIdentity(page?.url) !== identity || await observedUid() !== uid) return { outcome: 'blocked' };
    draft.url = page.url;
    await chrome.storage.session.set({ draft });
    const target = { tabId: tab.id };
    if (reel) {
      const [opened] = await chrome.scripting.executeScript({ target, func: openReelComments, args: [postUrl, deadline] });
      if (!opened?.result || !opened.documentId || await observedUid() !== uid) {
        await chrome.storage.session.set({ commentPrepareError: 'Không mở được khung bình luận đúng Reel.' });
        return { outcome: 'blocked' };
      }
      target.documentIds = [opened.documentId];
    }
    const view = await run(target, 'prepare');
    if (!view?.documentId || !view.result?.ok || await observedUid() !== uid) {
      await chrome.storage.session.set({ commentPrepareError: view?.result?.problem ?? 'Không xác nhận được tài liệu hoặc tài khoản.' });
      return { outcome: 'blocked' };
    }
    await chrome.storage.session.set({ draft: { ...draft, documentId: view.documentId } });
    return { outcome: 'prepared' };
  }
  if (command.action !== 'comment-commit' || draft?.kind !== 'comment' || draft.sessionId !== command.sessionId
    || draft.uid !== uid || !draft.documentId) return { outcome: 'blocked' };
  const target = { tabId: draft.tabId, documentIds: [draft.documentId] };
  if (!(await run(target, 'inspect'))?.result?.ok) return { outcome: 'blocked' };
  const requestedAt = Date.now();
  const permit = await api(config, { action: 'authorize', commandId: command.id });
  if (await observedUid() !== uid) return { outcome: 'blocked' };
  await chrome.storage.session.remove('draft');
  const result = (await run(target, 'commit', { ...input, deadline: Math.min(deadline, requestedAt + permit.lifetimeMs) }))?.result;
  return result?.ok ? { outcome: 'clicked', ...(result.receipt && { receipt: result.receipt }) } : { outcome: 'blocked' };
}

async function poll() {
  await discardExpired();
  const { config } = await chrome.storage.local.get('config');
  if (!config) return { state: 'DISCONNECTED' };
  const uid = await observedUid();
  const started = Date.now();
  const data = await api(config, { action: 'poll', radarProtocol: 1, commentProtocol: 1, researchProtocol: 1 });
  if (data.command) {
    const command = data.command;
    const deadline = started + command.lifetimeMs;
    if (command.action === 'radar-scan') {
      const report = await scanRadar(command.url, deadline, async () => !!uid && await observedUid() === uid).catch(() => null);
      await api(config, { action: 'radar-complete', commandId: command.id, report });
    } else if (command.action === 'research-scan') {
      const report = await scanResearch(command, deadline, async () => !!uid && await observedUid() === uid).catch(() => null);
      await api(config, { action: 'research-complete', commandId: command.id, report });
    } else if (['comment-prepare', 'comment-commit'].includes(command.action)) {
      const result = await executeComment(config, command, uid, deadline).catch(() => ({ outcome: 'blocked' }));
      await api(config, { action: 'complete', commandId: command.id, ...result });
    } else {
      const outcome = await execute(config, command, uid, deadline).catch(() => 'blocked');
      await api(config, { action: 'complete', commandId: command.id, outcome });
    }
  }
  return { state: data.state, code: data.code };
}

function pollOnce() {
  currentPoll ??= poll().catch(error => ({ state: 'ERROR', message: error.message }))
    .then(async result => {
      await chrome.storage.session.set({ status: { ...result, checkedAt: Date.now() } });
      return result;
    }).finally(() => { currentPoll = undefined; });
  return currentPoll;
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (!await chrome.alarms.get(pollAlarm)) await chrome.alarms.create(pollAlarm, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize().then(pollOnce); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === pollAlarm) void pollOnce(); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.url !== chrome.runtime.getURL('popup.html') || message?.action !== 'poll') return;
  void initialize().then(pollOnce).then(reply, error => reply({ state: 'ERROR', message: error.message }));
  return true;
});
