import { instagramAccess } from './research/instagram.js';

const defaultDashboardOrigin = 'http://localhost:3030';
const form = document.querySelector('form');
const token = document.querySelector('#token');
const status = document.querySelector('#status');
const checkButton = document.querySelector('#check');
const instagram = document.querySelector('#instagram');
const { config } = await chrome.storage.local.get('config');
const savedOrigin = config?.origin;
const dashboardOrigin = typeof savedOrigin === 'string' && savedOrigin.startsWith('https://') ? savedOrigin : defaultDashboardOrigin;
let configured = savedOrigin === dashboardOrigin && Boolean(config?.token);
document.querySelector('#origin').textContent = dashboardOrigin;
checkButton.disabled = !configured;

async function check() {
  if (!configured) {
    status.textContent = 'Dán mã profile để kết nối.';
    return;
  }
  status.textContent = 'Đang kiểm tra…';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'poll' });
    status.textContent = ({
      CONNECTED: 'Đã kết nối đích ' + result.code,
      WRONG_UID: 'Profile này đang đăng nhập sai UID.',
      LOGGED_OUT: 'Đăng nhập Facebook trong profile này.',
      DISCONNECTED: 'Dán mã profile để kết nối.',
    })[result.state] ?? result.message ?? 'Không kết nối được.';
    const { lastResearchIssue, lastCommentIssue } = await chrome.storage.session.get(['lastResearchIssue', 'lastCommentIssue']);
    if (result.state === 'CONNECTED' && lastResearchIssue) status.textContent += ' · Post Research: ' + lastResearchIssue;
    if (result.state === 'CONNECTED' && lastCommentIssue) status.textContent += ' · Bình luận: ' + lastCommentIssue;
  } catch (error) {
    status.textContent = error.message;
  }
}

checkButton.addEventListener('click', check);
instagram.disabled = await chrome.permissions.contains(instagramAccess);
if (instagram.disabled) instagram.textContent = 'Đã cho phép đọc Instagram';
instagram.addEventListener('click', async () => {
  try {
    if (!await chrome.permissions.request(instagramAccess)) {
      status.textContent = 'Cần quyền đọc trang Instagram trong Chrome profile này.';
      return;
    }
    instagram.disabled = true;
    instagram.textContent = 'Đã cho phép đọc Instagram';
    await check();
  } catch (error) {
    status.textContent = error.message;
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const url = new URL(dashboardOrigin);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
      throw new Error('Cấu hình dashboard cần dùng địa chỉ gốc HTTPS hoặc HTTP trên localhost.');
    }
    const key = token.value.trim();
    if (!/^profile_[\w-]{43}$/.test(key)) throw new Error('Nhập mã profile do dashboard cấp.');
    if (url.protocol === 'https:') {
      const allowed = await chrome.permissions.request({ origins: ['https://' + url.hostname + '/*'] });
      if (!allowed) throw new Error('Cần cho phép kết nối địa chỉ dashboard.');
    }
    const previous = (await chrome.storage.local.get('config')).config;
    await chrome.storage.local.set({
      config: { origin: url.origin, token: key, installationId: previous?.installationId ?? crypto.randomUUID() },
    });
    configured = true;
    checkButton.disabled = false;
    token.value = '';
    await check();
  } catch (error) {
    status.textContent = error.message;
  }
});

if (configured) void check();
else token.focus();
