import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireRoot = createRequire(new URL('../../package.json', import.meta.url));
const requireConnector = createRequire(new URL('../../packages/connectors/fb-web/package.json', import.meta.url));
const { chromium } = requireConnector('playwright-core') as typeof import('../../packages/connectors/fb-web/node_modules/playwright-core');
const { openReelComments } = requireRoot('./extension/reel-comments.js');
const { readResearch } = requireRoot('./extension/research/reader.js');
const { commentComposer, findPostedComment } = requireRoot('./extension/comment.js');
type Page = import('../../packages/connectors/fb-web/node_modules/playwright-core').Page;
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

async function withPage(url: string, html: string, check: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    await page.route('**/*', route => route.request().url() === url
      ? route.fulfill({ contentType: 'text/html; charset=UTF-8', body: html })
      : route.abort());
    await page.goto(url);
    await check(page);
  } finally {
    await browser.close();
  }
}

const invoke = (page: Page, fn: Function, ...args: unknown[]) =>
  page.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);

describe.skipIf(!executablePath)('extension comments in Chrome', () => {
  it('opens the requested Reel, reads its comments, and records only the new comment after one authorized click', async () => {
    await withPage(reel, pageHtml(750), async page => {
      const deadline = Date.now() + 15_000;
      const input = { postUrl: reel, text: message, uid: sender, deadline };
      expect(await invoke(page, openReelComments, reel, deadline)).toBe(true);
      expect(await page.evaluate('window.opened')).toEqual(['current']);
      expect(await invoke(page, readResearch, 'post', reel, 1, deadline)).toMatchObject({
        value: { authorURL: 'https://www.facebook.com/profile.php?id=' + author, comments: [{ externalId: '900', depth: 0 }] },
      });
      expect(await invoke(page, commentComposer, 'prepare', input)).toEqual({ ok: true });
      expect(await invoke(page, commentComposer, 'inspect', input)).toEqual({ ok: true });
      expect(await page.evaluate('window.sent')).toEqual([]);
      expect(await invoke(page, commentComposer, 'commit', input)).toEqual({ ok: true, receipt: {
        externalId: '901', permalink: reel + '?comment_id=901',
      } });
      expect(await invoke(page, commentComposer, 'commit', input)).toBeNull();
      expect(await page.evaluate('window.sent')).toEqual([message]);
    });
  });

  it('leaves both panels closed when two Reel comment buttons are on screen', async () => {
    await withPage(reel, pageHtml(180), async page => {
      expect(await invoke(page, openReelComments, reel, Date.now() + 500)).toBe(false);
      expect(await page.evaluate('window.opened')).toEqual([]);
    });
  });

  it('prepares a new comment on a regular post with no source comments when native insertion fails', async () => {
    const url = 'https://www.facebook.com/permalink.php?story_fbid=550&id=' + author;
    const html = `<!doctype html>
      <div role="dialog"><div role="dialog" aria-label="Bài viết của Tác giả">
        <a href="/profile.php?id=${author}">Tác giả</a>
        <a href="/photo.php?fbid=700">Ảnh đính kèm</a>
        <div data-testid="post_message">Bài kiểm thử</div>
        <div id="hint">Viết bình luận...</div>
        <div><div id="editor" contenteditable="true" aria-describedby="hint"><p><br></p></div>
          <button id="send" aria-label="Gửi bình luận" disabled>Gửi</button></div>
        <div id="comments"></div>
      </div></div>
      <script>
        document.execCommand = () => false;
        const editor = document.querySelector('#editor'), send = document.querySelector('#send');
        window.sent = [];
        editor.oninput = () => { send.disabled = !editor.innerText; };
        send.onclick = () => {
          window.sent.push(editor.innerText);
          const comment = document.createElement('article');
          comment.setAttribute('aria-label', 'Bình luận của Người gửi');
          comment.innerHTML = '<a href="/profile.php?id=${sender}">Người gửi</a><div dir="auto"></div>'
            + '<a href="/permalink.php?story_fbid=550&amp;id=${author}&amp;comment_id=902">Vừa xong</a>';
          comment.querySelector('[dir="auto"]').textContent = editor.innerText;
          document.querySelector('#comments').append(comment);
        };
      </script>`;
    await withPage(url, html, async page => {
      const deadline = Date.now() + 15_000;
      const input = { postUrl: url, text: message, uid: sender, deadline };
      expect(await invoke(page, readResearch, 'post', url, 1, deadline)).toMatchObject({
        value: { authorURL: 'https://www.facebook.com/profile.php?id=' + author, sourceKind: 'post', comments: [] },
      });
      expect(await invoke(page, commentComposer, 'prepare', input)).toEqual({ ok: true });
      expect(await invoke(page, commentComposer, 'inspect', input)).toEqual({ ok: true });
      expect(await page.evaluate('window.sent')).toEqual([]);
      expect(await invoke(page, commentComposer, 'commit', input)).toEqual({
        ok: true, receipt: { externalId: '902', permalink: url + '&comment_id=902' },
      });
      expect(await invoke(page, commentComposer, 'commit', input)).toBeNull();
      expect(await page.evaluate('window.sent')).toEqual([message]);
    });
  });

  it('finds the server comment after reopening the post when a single click yielded no immediate receipt', async () => {
    const url = 'https://www.facebook.com/permalink.php?story_fbid=560&id=' + author;
    const html = `<!doctype html>
      <main><article><a href="${url}">Bài đích</a><div data-testid="post_message">Kiểm thử đối chiếu</div></article>
        <div><div id="editor" role="textbox" contenteditable="true" aria-label="Viết bình luận" style="min-height:24px"></div>
          <button id="send" aria-label="Gửi bình luận" disabled>Gửi</button></div>
        <div id="comments"></div>
      </main>
      <script>
        const comments = document.querySelector('#comments');
        function add(uid, id) {
          const card = document.createElement('article');
          card.setAttribute('aria-label', 'Bình luận');
          card.innerHTML = '<a href="/profile.php?id='+uid+'">Người gửi</a><div dir="auto">${message}</div>'
            + '<a href="${url}&amp;comment_id='+id+'">Thời gian</a>';
          comments.append(card);
        }
        add('${sender}', '910');
        if (localStorage.getItem('clicks')) {
          add('${sender}', '911');
          add('${author}', '912');
        }
        const editor = document.querySelector('#editor'), send = document.querySelector('#send');
        editor.oninput = () => { send.disabled = !editor.innerText; };
        send.onclick = () => localStorage.setItem('clicks', Number(localStorage.getItem('clicks') || 0) + 1);
      </script>`;
    await withPage(url, html, async page => {
      const deadline = Date.now() + 25_000;
      const input = { postUrl: url, text: message, uid: sender, deadline };
      const read = async () => (await invoke(page, readResearch, 'post', url, 20, deadline) as {
        value: { comments: Array<{ externalId: string; rootExternalId: string }>; stoppedEarly: boolean };
      }).value;
      const before = await read();
      expect(before).toMatchObject({ stoppedEarly: false, comments: [{ externalId: '910' }] });
      expect(await invoke(page, commentComposer, 'prepare', input)).toEqual({ ok: true });
      expect(await invoke(page, commentComposer, 'commit', input)).toEqual({ ok: true });
      expect(await invoke(page, commentComposer, 'commit', input)).toBeNull();
      await page.reload();
      const after = await read();
      expect(findPostedComment(input, before, after)).toEqual({ externalId: '911', permalink: url + '&comment_id=911' });
      expect(findPostedComment(input, before, after, ['911'])).toBeNull();
      expect(findPostedComment(input, { ...before, stoppedEarly: true }, after)).toBeNull();
      const duplicate = { ...after.comments[1], externalId: '913', rootExternalId: '913' };
      expect(findPostedComment(input, before, { ...after, comments: [...after.comments, duplicate] })).toBeNull();
      expect(await page.evaluate("localStorage.getItem('clicks')")).toBe('1');
    });
  });
});
