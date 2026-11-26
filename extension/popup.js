const form = document.querySelector('form');
const address = document.querySelector('#origin');
const token = document.querySelector('#token');
const status = document.querySelector('#status');
const { config } = await chrome.storage.local.get('config');
if (config) address.value = config.origin;

async function check() {
  status.textContent = 'Đang kiểm tra…';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'poll' });
    status.textContent = ({
      CONNECTED: 'Đã kết nối đích ' + result.code,
      WRONG_UID: 'Profile này đang đăng nhập sai UID.',
      LOGGED_OUT: 'Đăng nhập Facebook trong profile này.',
      DISCONNECTED: 'Nhập địa chỉ và mã profile để kết nối.',
    })[result.state] ?? result.message ?? 'Không kết nối được.';
    const { commentPrepareError } = await chrome.storage.session.get('commentPrepareError');
    if (commentPrepareError) status.textContent += ' ' + commentPrepareError;
  } catch (error) {
    status.textContent = error.message;
  }
}

document.querySelector('#check').addEventListener('click', check);
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const url = new URL(address.value);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
      throw new Error('Dùng địa chỉ gốc HTTPS, hoặc HTTP trên localhost.');
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
    token.value = '';
    await check();
  } catch (error) {
    status.textContent = error.message;
  }
});

if (config) void check();
