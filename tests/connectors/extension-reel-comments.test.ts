import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireRoot = createRequire(new URL('../../package.json', import.meta.url));
const requireConnector = createRequire(new URL('../../packages/connectors/fb-web/package.json', import.meta.url));
const { chromium } = requireConnector('playwright-core') as typeof import('../../packages/connectors/fb-web/node_modules/playwright-core');
const { openReelComments } = requireRoot('./extension/reel-comments.js');
const { readResearch } = requireRoot('./extension/research/reader.js');
const { commentComposer } = requireRoot('./extension/comment.js');
const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
const reel = 'https://www.facebook.com/reel/440/';
const author = '123456789';
const sender = '223456789';
const message = 'Bình luận kiểm thử';

const pageHtml = (nextTop: number) => `<!doctype html>
<main>
  <div style="position:absolute;top:20px"><video width="200" height="100"></video><button id="open" aria-label="Bình luận, 1 bình luận">Comments</button></div>
  <div style="position:absolute;top:${nextTop}px"><video width="200" height="100"></video><button id="next" aria-label="Bình luận, 5 bình luận">Other Reel</button></div>
</main>
<aside id="sidebar" hidden style="position:absolute;left:400px;top:20px">
  <h2><a href="/profile.php?id=${author}">Chủ bài</a></h2>
  <div>
    <h2>Bình luận</h2>
    <div id="comments">
      <article aria-label="Bình luận dưới tên Người gửi">
        <a href="/profile.php?id=${sender}&amp;comment_id=900">Người gửi</a>
        <div dir="auto">Bình luận cũ</div>
        <a href="/reel/440/?comment_id=900">1 phút</a>
      </article>
    </div>
    <form>
      <div><div><div><div><div><div><div>
        <div id="editor" role="textbox" contenteditable="true" aria-placeholder="Viết bình luận..." style="min-height:24px;border:1px solid"></div>
      </div></div></div></div></div></div></div>
      <button type="button" id="send" aria-label="Đăng bình luận" disabled>Đăng</button>
    </form>
  </div>
</aside>
<script>
  window.opened = [];
  window.sent = [];
  document.querySelector('#open').onclick = () => {
    opened.push('current');
    document.querySelector('#sidebar').hidden = false;
  };
  document.querySelector('#next').onclick = () => opened.push('other');
  const editor = document.querySelector('#editor');
  const send = document.querySelector('#send');
  editor.oninput = () => { send.disabled = !editor.innerText; };
  send.onclick = () => {
    sent.push(editor.innerText);
    const item = document.createElement('article');
    item.setAttribute('aria-label', 'Bình luận dưới tên Người gửi');
    item.innerHTML = '<a href="/profile.php?id=${sender}">Người gửi</a><div dir="auto"></div><a href="/reel/440/?comment_id=901">Vừa xong</a>';
    item.querySelector('[dir="auto"]').textContent = editor.innerText;
    document.querySelector('#comments').appendChild(item);
    editor.textContent = '';
    send.disabled = true;
  };
</script>`;

async function withReel(nextTop: number, check: (page: import('../../packages/connectors/fb-web/node_modules/playwright-core').Page) => Promise<void>) {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    await page.route('**/*', route => route.request().url() === reel
      ? route.fulfill({ contentType: 'text/html; charset=UTF-8', body: pageHtml(nextTop) })
      : route.abort());
    await page.goto(reel);
    await check(page);
  } finally {
    await browser.close();
  }
}

describe.skipIf(!executablePath)('extension Reel comments', () => {
  it('opens the requested Reel, reads its comments, and records only the new comment after one authorized click', async () => {
    await withReel(750, async page => {
      const deadline = Date.now() + 15_000;
      const input = { postUrl: reel, text: message, uid: sender, deadline };
      const invoke = (fn: Function, ...args: unknown[]) => page.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
      expect(await invoke(openReelComments, reel, deadline)).toBe(true);
      expect(await page.evaluate('window.opened')).toEqual(['current']);
      expect(await invoke(readResearch, 'post', reel, 1, deadline)).toMatchObject({
        value: { authorURL: 'https://www.facebook.com/profile.php?id=' + author, comments: [{ externalId: '900', depth: 0 }] },
      });
      expect(await invoke(commentComposer, 'prepare', input)).toEqual({ ok: true });
      expect(await invoke(commentComposer, 'inspect', input)).toEqual({ ok: true });
      expect(await page.evaluate('window.sent')).toEqual([]);
      expect(await invoke(commentComposer, 'commit', input)).toEqual({ ok: true, receipt: {
        externalId: '901', permalink: reel + '?comment_id=901',
      } });
      expect(await invoke(commentComposer, 'commit', input)).toBeNull();
      expect(await page.evaluate('window.sent')).toEqual([message]);
    });
  });

  it('leaves both panels closed when two Reel comment buttons are on screen', async () => {
    await withReel(180, async page => {
      expect(await page.evaluate(`(${openReelComments.toString()})(${JSON.stringify(reel)}, ${Date.now() + 500})`)).toBe(false);
      expect(await page.evaluate('window.opened')).toEqual([]);
    });
  });
});
