import { composer } from './composer.js';
import { scanRadar } from './radar-scan.js';

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
  if (command.action !== 'commit' || draft?.sessionId !== command.sessionId
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

async function poll() {
  await discardExpired();
  const { config } = await chrome.storage.local.get('config');
  if (!config) return { state: 'DISCONNECTED' };
  const uid = await observedUid();
  const started = Date.now();
  const data = await api(config, { action: 'poll', radarProtocol: 1 });
  if (data.command) {
    const command = data.command;
    const deadline = started + command.lifetimeMs;
    if (command.action === 'radar-scan') {
      const report = await scanRadar(command.url, deadline, async () => !!uid && await observedUid() === uid).catch(() => null);
      await api(config, { action: 'radar-complete', commandId: command.id, report });
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
