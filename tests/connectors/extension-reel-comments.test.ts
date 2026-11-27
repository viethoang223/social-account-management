import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const requireRoot = createRequire(new URL('../../package.json', import.meta.url));
const requireConnector = createRequire(new URL('../../packages/connectors/fb-web/package.json', import.meta.url));
const { chromium } = requireConnector('playwright-core') as typeof import('../../packages/connectors/fb-web/node_modules/playwright-core');
const { openReelComments } = requireRoot('./extension/reel-comments.js');
const { readResearch } = requireRoot('./extension/research/reader.js');
const { commentComposer, findPostedComment } = requireRoot('./extension/comment.js');
const { composer } = requireRoot('./extension/composer.js');
const { findPublishedText } = requireRoot('./extension/research/job.js');
const { readPublicationEvidence } = requireRoot('./extension/research/publication-verify.js');
const { readInstagram, scanInstagramStep } = requireRoot('./extension/research/instagram.js');
const { readInstagramEmbed } = requireRoot('./extension/research/instagram-embed.js');
const { observeInstagramThread } = requireRoot('./extension/research/instagram-thread.js');
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

it.skipIf(!executablePath).each([false, true])('selects Public in Reel settings and rechecks it before sending (separate label: %s)', async separate => {
  const file = Buffer.from('sample Reel');
  const media = { format: 'REEL', mime: 'video/mp4', size: file.length, checksum: createHash('sha256').update(file).digest('hex') };
  const audience = separate
    ? '<div><button id="audience">Who can see this reel?</button><span id="current">Friends</span></div>'
    : '<button id="audience"><span id="current">Friends</span></button>';
  await withPage('https://www.facebook.com/profile.php?id=123456789', `<!doctype html>
    <button id="open">Create reel</button>
    <div id="draft" role="dialog" hidden><h2>Reel settings</h2>
      <textarea></textarea><input type="file" accept="video/*"><video width="80" height="80" hidden></video>
      ${audience}<button id="share">Share reel</button>
    </div>
    <div id="picker" role="dialog" hidden><h2>Select audience</h2>
      <button id="public" role="radio" aria-checked="false"><span>Public</span></button><button id="done">Done</button>
    </div>
    <script>
      const el = id => document.getElementById(id);
      el('open').onclick = () => el('draft').hidden = false;
      document.querySelector('input').onchange = () => document.querySelector('video').hidden = false;
      el('audience').onclick = () => el('picker').hidden = false;
      el('public').onclick = () => el('public').setAttribute('aria-checked','true');
      el('done').onclick = () => {
        if (el('public').getAttribute('aria-checked') === 'true') el('current').textContent = 'Public';
        el('picker').hidden = true;
      };
      el('share').onclick = () => document.body.dataset.shared = 'yes';
    </script>`, async page => {
    const caption = 'Caption Reel gốc';
    const deadline = Date.now() + 15_000;
    expect(await invoke(page, composer, 'stage-media', '', deadline, 'PUBLIC', media, 'reel-1',
      { offset: 0, data: file.toString('base64') })).toBe(true);
    expect(await invoke(page, composer, 'prepare', caption, deadline, 'PUBLIC', media, 'reel-1')).toBe(true);
    expect(await page.locator('#current').innerText()).toBe('Public');
    await page.locator('#current').evaluate(el => el.textContent = 'Friends');
    expect(await invoke(page, composer, 'commit', caption, deadline, 'PUBLIC', media, 'reel-1')).toBe(false);
    expect(await page.locator('body').getAttribute('data-shared')).toBeNull();
    await page.locator('#current').evaluate(el => el.textContent = 'Public');
    expect(await invoke(page, composer, 'commit', caption, deadline, 'PUBLIC', media, 'reel-1')).toBe(true);
    expect(await page.locator('body').getAttribute('data-shared')).toBe('yes');
  });
});

it.skipIf(!executablePath).each([false, true])('verifies the photo, caption and public audience before posting (direct: %s)', async direct => {
  const caption = 'Bài ảnh thử\n\nDòng thứ hai';
  const file = Buffer.from('sample-image');
  const media = { format: 'SINGLE_PHOTO', mime: 'image/jpeg', size: file.length, checksum: createHash('sha256').update(file).digest('hex') };
  await withPage('https://www.facebook.com/profile.php?id=123456789', `<!doctype html>
    <button id="open">What's on your mind?</button>
    <div id="draft" role="dialog" hidden><h2>Create post</h2><button id="aud">Friends</button>
      <div role="textbox" contenteditable="true" style="min-height: 30px"><p><br></p></div>
      <input type="file" accept="image/*"><div id="image" hidden><button>Remove post attachment</button></div><button id="next" disabled>${direct ? 'Post' : 'Next'}</button>
    </div>
    <div id="picker" role="dialog" hidden><h2>Post audience</h2><div role="radio" aria-labelledby="public-label" id="public"></div>
      <div style="min-height:36px" id="public-label">Public Anyone on or off Facebook</div><button id="done">Done</button>
    </div>
    <div id="review" role="dialog" hidden><div role="dialog" aria-label="Post settings"><h2>Post settings</h2><button>Back</button></div><div id="preview"></div>
      <button>Post audience <span>Public</span></button><button>post.jpg</button><button id="submit">Post</button></div>
    <script>
      const el = id => document.getElementById(id);
      el('open').onclick = () => el('draft').hidden = false;
      el('aud').onclick = () => { el('draft').hidden = true; el('picker').hidden = false; };
      el('public').style = 'width: 55px; height: 22px;';
      el('public').onclick = () => el('aud').textContent = 'Public';
      el('done').onclick = () => { el('picker').hidden = true; el('draft').hidden = false; };
      document.querySelector('input').onchange = () => { el('image').hidden = false; setTimeout(() => el('next').disabled = false, 800); };
      const submit = () => document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1);
      el('next').onclick = ${direct ? 'submit' : `() => { el('preview').textContent = document.querySelector('[role=textbox]').innerText; el('draft').hidden = true; el('review').hidden = false; }`};
      el('submit').onclick = submit;
    </script>`, async page => {
    const deadline = Date.now() + 15_000;
    expect(await invoke(page, composer, 'stage-media', '', deadline, 'PUBLIC', media, 'draft-1', { offset: 0, data: file.toString('base64') })).toBe(true);
    expect(await invoke(page, composer, 'prepare', caption, deadline, 'PUBLIC', media, 'draft-1')).toBe(true);
    expect(await page.locator('body').getAttribute('data-clicks')).toBeNull();
    if (!direct) await page.locator('#review').evaluate(el => {
      const replacement = el.cloneNode(true) as HTMLElement;
      replacement.querySelector<HTMLButtonElement>('#submit')!.onclick = () => document.body.dataset.clicks = '1';
      el.replaceWith(replacement);
    });
    expect(await invoke(page, composer, 'commit', caption, deadline, 'PUBLIC', media, 'draft-1')).toBe(true);
    expect(await page.locator('body').getAttribute('data-clicks')).toBe('1');
  });
});

it.skipIf(!executablePath)('finds a publication by its matching author, caption and photo link on a professional timeline', async () => {
  const url = 'https://www.facebook.com/profile.php?id=123456789';
  const permalink = 'https://www.facebook.com/photo/?fbid=1822';
  const caption = 'Thử nhận diện bài ảnh trong trang cá nhân';
  await withPage(url, `<!doctype html><main><section>
    <h3><a href="${url}">Người viết</a></h3><button aria-label="Actions for this post by Người viết"></button>
    <div dir="auto">${caption}</div><a href="${permalink}">Ảnh</a>
  </section></main>`, async page => {
    const response = await invoke(page, readResearch, 'publication', url, 1, Date.now() + 5000, caption) as { value: { rows: unknown[] } };
    expect(findPublishedText('123456789', caption, { rows: [] }, response.value, true)).toEqual({ externalId: '1822', permalink });
  });
});

it.skipIf(!executablePath)('attaches an album in order and refuses to submit when a media tile is missing', async () => {
  const caption = 'Album với ảnh và video';
  await withPage('https://www.facebook.com/profile.php?id=123456789', `<!doctype html>
    <button id="open">What's on your mind?</button>
    <div id="draft" role="dialog" hidden><h2>Create post</h2><button>Public</button>
      <div role="textbox" contenteditable="true" style="min-height: 30px"></div>
      <input type="file" accept="image/*,video/*" multiple>
      <div id="previews"><div><img id="photo" width="80" height="80" hidden></div><div><video width="80" height="80" hidden></video></div></div>
      <button id="post">Post</button>
    </div>
    <script>
      const el = id => document.getElementById(id);
      el('open').onclick = () => el('draft').hidden = false;
      document.querySelector('input').onchange = event => {
        const files = [...event.target.files];
        document.body.dataset.files = files.map(file => file.name + ':' + file.type).join(',');
        el('photo').src = URL.createObjectURL(files[0]);
        el('photo').hidden = false;
        document.querySelector('video').hidden = false;
      };
      el('post').onclick = () => document.body.dataset.clicked = 'yes';
    </script>`, async page => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 80;
      return canvas.toDataURL().split(',')[1];
    });
    const payloads = [Buffer.from(png, 'base64'), Buffer.from('fixture video')];
    const media = { format: 'MEDIA_ALBUM', files: payloads.map((file, index) => ({
      mime: index === 0 ? 'image/png' : 'video/mp4', size: file.length, checksum: createHash('sha256').update(file).digest('hex'),
    })) };
    const deadline = Date.now() + 15_000;
    for (const [fileIndex, file] of payloads.entries()) {
      expect(await invoke(page, composer, 'stage-media', '', deadline, 'PUBLIC', media, 'album-1',
        { fileIndex, offset: 0, data: file.toString('base64') })).toBe(true);
    }
    expect(await invoke(page, composer, 'prepare', caption, deadline, 'PUBLIC', media, 'album-1')).toBe(true);
    expect(await page.locator('body').getAttribute('data-files')).toBe('post-1.png:image/png,post-2.mp4:video/mp4');
    await page.locator('video').evaluate(el => (el as HTMLElement).hidden = true);
    expect(await invoke(page, composer, 'commit', caption, deadline, 'PUBLIC', media, 'album-1')).toBe(false);
    expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    await page.locator('video').evaluate(el => (el as HTMLElement).hidden = false);
    expect(await invoke(page, composer, 'commit', caption, deadline, 'PUBLIC', media, 'album-1')).toBe(true);
    expect(await page.locator('body').getAttribute('data-clicked')).toBe('yes');
  });
});

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

it.skipIf(!executablePath)('reads the caption and both visible Instagram carousel slides in order', async () => {
  const url = 'https://www.instagram.com/p/Example123/';
  const first = 'https://scontent.cdninstagram.com/image-1.jpg';
  const second = 'https://scontent.cdninstagram.com/image-2.jpg';
  await withPage(url, `<!doctype html><main><article><header><a href="/creator/">creator</a></header>
    <img id="slide" src="${first}" width="360" height="320">
    <h1>Caption nguồn Instagram</h1>
    <button id="next" aria-label="Next">›</button>
  </article></main>
  <script>document.querySelector('#next').onclick = event => {
    document.querySelector('#slide').src = '${second}';
    event.currentTarget.hidden = true;
  };</script>`, async page => {
    expect(await invoke(page, readInstagram, 'post', url, 10, Date.now() + 10_000)).toMatchObject({
      kind: 'RESEARCH_POST', body: 'Caption nguồn Instagram', authorUrl: 'https://www.instagram.com/creator/',
      mediaPartial: false, instagramMedia: [{ kind: 'image', url: first }, { kind: 'image', url: second }],
    });
  });
});

it.skipIf(!executablePath)('reads an Instagram comment and its reply from the selected post without reading the caption as a comment', async () => {
  const url = 'https://www.instagram.com/p/Thread123/';
  await withPage(url, `<!doctype html><main><article>
    <header><a href="/creator/">creator</a></header><h1>Caption của bài</h1>
    <button type="button" id="open" aria-label="Comments">Bình luận</button>
  </article></main>
  <section role="dialog" aria-label="Comments" id="thread" hidden>
    <div data-comment-id="100"><a href="/alice/">alice</a><span data-comment-text>Bình luận gốc</span></div>
    <div data-comment-id="101" data-parent-comment-id="100"><a href="/bob/">bob</a><span dir="auto">Phản hồi</span></div>
  </section>
  <script>document.querySelector('#open').onclick = () => document.querySelector('#thread').hidden = false;</script>`, async page => {
    const result = await invoke(page, readInstagram, 'comments', url, 20, Date.now() + 10_000);
    expect(result).toMatchObject({ kind: 'RESEARCH_POST', url, instagramCommentStatus: 'READ', comments: [
      { externalId: '100', parentExternalId: null, name: 'alice', text: 'Bình luận gốc', depth: 0 },
      { externalId: '101', parentExternalId: '100', name: 'bob', text: 'Phản hồi', depth: 1 },
    ], instagramMedia: [] });
  });
});

it('extracts only the matching Instagram Reel from embed metadata', () => {
  const mp4 = 'https://scontent.cdninstagram.com/sample.mp4';
  const item = (shortcode: string, video_url: string) => ({ shortcode, __typename: 'GraphVideo',
    id: '123456789012', is_video: true, video_url, edge_media_to_caption: { edges: [{ node: { text: 'Nguồn Instagram' } }] },
    edge_media_to_comment: { count: 2 },
  });
  const input = (entry: object) => JSON.stringify(JSON.stringify({ context: { media: entry } }));
  const html = `<script>boot(${input(item('Other', mp4))});boot(${input(item('Correct', mp4))});</script>`;
  expect(readInstagramEmbed(html, 'Correct')).toMatchObject({ caption: 'Nguồn Instagram', comments: 2, video: mp4, mediaId: '123456789012',
    declaredMediaCount: 1, media: [{ kind: 'video', url: mp4 }] });
  expect(readInstagramEmbed(html, 'Absent')).toBeNull();
  expect(readInstagramEmbed(`<script>boot(${input(item('Correct', 'https://invalid.example/sample.mp4'))})</script>`, 'Correct').video).toBeNull();
});

it('uses the largest available image for each slide instead of a thumbnail in the embed', () => {
  const cdn = 'https://scontent.cdninstagram.com/';
  const node = (name: string) => ({
    __typename: 'GraphImage', display_url: cdn + name + '-640.jpg',
    display_resources: [1080, 1440, 640].map(width => ({ config_width: width, src: cdn + name + '-' + width + '.jpg' })),
  });
  const item = { shortcode: 'AlbumQuality', __typename: 'GraphSidecar', edge_media_to_caption: { edges: [] },
    edge_sidecar_to_children: { edges: [{ node: node('first') }, { node: node('second') }] } };
  const html = '<script>boot(' + JSON.stringify(JSON.stringify({ media: item })) + ');</script>';
  expect(readInstagramEmbed(html, item.shortcode)).toMatchObject({ declaredMediaCount: 2, media: [
    { kind: 'image', url: cdn + 'first-1440.jpg' }, { kind: 'image', url: cdn + 'second-1440.jpg' },
  ] });
});

it.skipIf(!executablePath)('reads Instagram div comments and uses a permalink-bound Reel file', async () => {
  const url = 'https://www.instagram.com/reel/Actual123/';
  const mp4 = 'https://scontent.cdninstagram.com/reel.mp4';
  await withPage(url, `<!doctype html><main><article>
    <header><a href="/creator/">creator</a></header><video width="300" height="250"></video><h1>Other UI text</h1>
    <div class="comment"><div><a href="/alice/">alice</a> <span dir="auto">Bình luận nguồn</span></div><div><span>Reply</span></div></div>
  </article></main>`, async page => {
    const result = await invoke(page, readInstagram, 'post', url, 10, Date.now() + 7000, null, null, {
      caption: 'Caption gốc…', comments: 1, video: mp4,
    });
    expect(result).toMatchObject({ body: 'Caption gốc…', captionPartial: false, mediaPartial: false,
      instagramMedia: [{ kind: 'video', url: mp4 }], instagramCommentStatus: 'READ',
      comments: [{ name: 'alice', text: 'Bình luận nguồn' }],
    });
  });
});

it.skipIf(!executablePath)('uses only a naturally loaded comment response for the requested Instagram media ID', async () => {
  const url = 'https://www.instagram.com/p/ThreadReal/';
  await withPage(url, '<main></main>', async page => {
    await page.evaluate(() => {
      window.fetch = async () => new Response(JSON.stringify({ data: {
        xdt_api__v1__media__media_id__comments: { comments: [{ pk: '123456789013', user: { username: 'alice' }, text: 'Bình luận gốc' }] },
      } }), { status: 200 });
    });
    await invoke(page, observeInstagramThread, 'start', 'thread', '123456789012', 10);
    await page.evaluate(async () => {
      await fetch('/api/v1/media/000000000000/comments/');
      await fetch('/graphql/query', { method: 'POST', body: new URLSearchParams({
        fb_api_req_friendly_name: 'PolarisPostCommentsPaginationQuery',
        variables: JSON.stringify({ media_id: '123456789012' }),
      }) });
      await new Promise(resolve => setTimeout(resolve, 70));
    });
    expect(await invoke(page, observeInstagramThread, 'finish', 'thread', '123456789012', 10))
      .toEqual([{ externalId: '123456789013', parentExternalId: null, name: 'alice', text: 'Bình luận gốc', depth: 0 }]);
  });
});

it.skipIf(!executablePath)('reads a signed-in Instagram thread only on its matching permalink', async () => {
  await withPage('https://www.instagram.com/reel/ThreadReal/', '<main></main>', async page => {
    await page.evaluate(() => {
      window.fetch = async (url, options) => {
        if (new URL(String(url), location.origin).pathname !== '/api/v1/media/123456789012/comments/' || options?.credentials !== 'same-origin') {
          return new Response(null, { status: 403 });
        }
        return Response.json({ comments: [{ pk: '123456789013', user: { username: 'alice' }, text: 'Bình luận gốc',
          child_comments: [{ pk: '123456789014', user: { username: 'bob' }, text: 'Trả lời gốc' }] }] });
      };
    });
    expect(await invoke(page, observeInstagramThread, 'read', 'thread', '123456789012', 10, 'Different'))
      .toEqual({ comments: [], check: 'NAVIGATION' });
    expect(await invoke(page, observeInstagramThread, 'read', 'thread', '123456789012', 10, 'ThreadReal'))
      .toMatchObject({ check: 'READ', stats: { firstPage: 2, pages: 1, replyRequests: 0 }, comments: [
        { externalId: '123456789013', parentExternalId: null, name: 'alice', text: 'Bình luận gốc', depth: 0 },
        { externalId: '123456789014', parentExternalId: '123456789013', name: 'bob', text: 'Trả lời gốc', depth: 1 },
      ] });
    await page.evaluate(() => { window.fetch = async () => new Response(null, { status: 429 }); });
    expect(await invoke(page, observeInstagramThread, 'read', 'thread', '123456789012', 10, 'ThreadReal'))
      .toMatchObject({ comments: [], check: 'RATE_LIMITED', stats: { firstPage: 0, pages: 0, replyRequests: 0 } });
  });
});

it.skipIf(!executablePath)('continues Instagram comment and reply pages using their own cursors', async () => {
  await withPage('https://www.instagram.com/p/ThreadReal/', '<main></main>', async page => {
    await page.evaluate(() => {
      const base = '/api/v1/media/123456789012/comments/';
      const rootCursor = '{"cached_comments_cursor":"a+b"}';
      const comment = (pk: string) => ({ pk, user: { username: 'alice' }, text: 'Bình luận ' + pk });
      const root = { ...comment('123456789013'), child_comment_count: 3,
        preview_child_comments: [comment('123456789015')] };
      const routes = {
        root: { comments: [root], next_min_id: rootCursor },
        more: { comments: [root, comment('123456789014')], next_min_id: rootCursor },
        children: { child_comments: [comment('123456789015'), comment('123456789016')], next_max_child_cursor: 'reply+/=' },
        moreChildren: { child_comments: [comment('123456789017')] },
      };
      window.fetch = async input => {
        const url = new URL(String(input), location.origin);
        if (url.pathname === base && !url.searchParams.has('min_id')) return Response.json(routes.root);
        if (url.pathname === base && url.searchParams.get('min_id') === rootCursor) return Response.json(routes.more);
        if (url.pathname === base + root.pk + '/child_comments/' && !url.searchParams.has('max_id')) return Response.json(routes.children);
        if (url.pathname === base + root.pk + '/child_comments/' && url.searchParams.get('max_id') === 'reply+/=') return Response.json(routes.moreChildren);
        return new Response(null, { status: 400 });
      };
    });
    const result = await invoke(page, observeInstagramThread, 'read', 'thread', '123456789012', 20, 'ThreadReal', 5) as {
      check: string; stats: unknown; comments: Array<{ externalId: string; parentExternalId: string | null }>;
    };
    expect(result.check).toBe('READ');
    expect(result.stats).toMatchObject({ firstPage: 2, pages: 2, replyRequests: 2 });
    expect(result.comments.map(row => [row.externalId, row.parentExternalId])).toEqual([
      ['123456789013', null], ['123456789015', '123456789013'], ['123456789014', null],
      ['123456789016', '123456789013'], ['123456789017', '123456789013'],
    ]);
  });
});

it.skipIf(!executablePath)('uses the recent view and inline reply cursor only when the Instagram thread is short', async () => {
  await withPage('https://www.instagram.com/p/ThreadReal/', '<main></main>', async page => {
    await page.evaluate(() => {
      const base = '/api/v1/media/123456789012/comments/';
      const comment = (pk: string) => ({ pk, user: { username: 'alice' }, text: pk });
      const root = { ...comment('123456789013'), child_comment_count: 1, next_max_child_cursor: 'inline' };
      window.fetch = async input => {
        const url = new URL(String(input), location.origin);
        if (url.pathname === base) return Response.json({ comment_count: 3, comments: url.searchParams.get('sort_order') === 'recent'
          ? [root, comment('123456789015')] : [root] });
        if (url.pathname === base + root.pk + '/child_comments/') return Response.json({ child_comments: [] });
        if (url.pathname === base + root.pk + '/inline_child_comments/' && url.searchParams.get('max_id') === 'inline') {
          return Response.json({ child_comments: [comment('123456789014')] });
        }
        return new Response(null, { status: 400 });
      };
    });
    const result = await invoke(page, observeInstagramThread, 'read', 'thread', '123456789012', 20, 'ThreadReal', 3) as {
      stats: unknown; comments: Array<{ externalId: string }>;
    };
    expect(result.stats).toMatchObject({ firstPage: 1, pages: 2, replyRequests: 2, roots: 2, advertisedReplies: 1, reported: 3 });
    expect(result.comments.map(row => row.externalId)).toEqual(['123456789013', '123456789014', '123456789015']);
  });
});

it.skipIf(!executablePath)('finds 40 distinct links when the Instagram profile grid renders late', async () => {
  const url = 'https://www.instagram.com/example_creator/';
  const html = `<!doctype html><main><input type="password" hidden><div id="grid"></div></main><script>
    const grid = document.querySelector('#grid');
    let total = 0;
    let loading = false;
    function loadGrid() {
      loading = false;
      for (let step = 0; step < 12; step++) {
        const link = document.createElement('a');
        link.href = '/example_creator/p/Example_' + (++total) + '/';
        link.textContent = 'Bài Instagram';
        link.style.cssText = 'display:block;height:90px';
        grid.append(link);
      }
    }
    setTimeout(loadGrid, 1800);
    window.addEventListener('scroll', () => {
      if (!loading && window.scrollY + window.innerHeight >= grid.scrollHeight - 10 && total < 48) {
        loading = true;
        setTimeout(loadGrid, 550);
      }
    });
  </script>`;
  await withPage(url, html, async page => {
    const report = await invoke(page, readInstagram, 'profile', url, 40, Date.now() + 12_000) as { rows: Array<{ url: string }> };
    expect(report.rows.map(row => row.url)).toEqual(Array.from({ length: 40 }, (_, index) =>
      `https://www.instagram.com/p/Example_${index + 1}/`));
  });
});

it.skipIf(!executablePath)('identifies an Instagram login redirect in the same browser document', async () => {
  const profile = 'https://www.instagram.com/example_creator/';
  await withPage('https://www.instagram.com/accounts/login/', '<main><form><input type="password"></form></main>', async page => {
    expect(await invoke(page, readInstagram, 'profile', profile, 40, Date.now() + 5_000)).toEqual({ issue: 'IG_LOGIN' });
  });
});

it.skipIf(!executablePath)('loads Instagram batches through Show more and preserves the first 12 links at a login gate', async () => {
  const url = 'https://www.instagram.com/example_creator/';
  const html = (guest: boolean) => `<!doctype html><main><div id="grid"></div>
    <button id="more">Show more posts from example_creator</button></main>
    <div role="dialog" hidden id="login">See photos, videos and more from example_creator <a href="/accounts/login/">Log in</a></div>
    <script>
      const grid = document.querySelector('#grid');
      const more = document.querySelector('#more');
      let total = 0;
      function addBatch() {
        for (let i = 0; i < 12; i++) {
          const a = document.createElement('a');
          a.href = '/example_creator/p/Post_' + (++total) + '/';
          a.textContent = 'Post';
          a.style.cssText = 'display:block;height:90px';
          grid.append(a);
        }
      }
      addBatch();
      more.onclick = () => {
        if (${guest}) document.querySelector('#login').hidden = false;
        else { addBatch(); if (total === 48) more.hidden = true; }
      };
    </script>`;
  for (const guest of [false, true]) await withPage(url, html(guest), async page => {
    const result = await invoke(page, readInstagram, 'profile', url, 40, Date.now() + 10_000) as { rows: unknown[]; stopReason?: string };
    expect(result.rows).toHaveLength(guest ? 12 : 40);
    expect(result.stopReason).toBe(guest ? 'IG_LOGIN' : undefined);
  });
});

it.skipIf(!executablePath)('walks through each viewport in a nested Instagram grid until 40 links render', async () => {
  const url = 'https://www.instagram.com/example_creator/';
  const html = `<!doctype html><main><div id="grid" style="height:420px;overflow-y:auto"></div></main><script>
    const grid = document.querySelector('#grid');
    let total = 0;
    function addBatch() {
      const checkpoints = [];
      for (let i = 0; i < 12; i++) {
        const a = document.createElement('a');
        a.href = '/example_creator/p/Post_' + (++total) + '/';
        a.textContent = 'Post';
        a.style.cssText = 'display:block;height:140px';
        grid.append(a);
        if (i === 4 || i === 10) checkpoints.push(a);
      }
      if (total >= 48) return;
      const observed = new Set();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) observed.add(entry.target);
        if (observed.size === checkpoints.length) {
          observer.disconnect();
          setTimeout(addBatch, 750);
        }
      }, { root: grid, threshold: 0.25 });
      checkpoints.forEach(checkpoint => observer.observe(checkpoint));
    }
    addBatch();
  </script>`;
  await withPage(url, html, async page => {
    const report = await invoke(page, readInstagram, 'profile', url, 40, Date.now() + 24_000) as { rows: Array<{ url: string }>; scrollSteps: number; partial: boolean };
    expect(report.rows.map(row => row.url)).toEqual(Array.from({ length: 40 }, (_, i) => `https://www.instagram.com/p/Post_${i + 1}/`));
    expect(report.scrollSteps).toBeGreaterThan(8);
    expect(report.partial).toBe(false);
  });
});

it.skipIf(!executablePath)('returns a resumable checkpoint when an Instagram step ends and later extends it to 40 links', async () => {
  const url = 'https://www.instagram.com/example_creator/';
  const links = (start: number, end: number) => Array.from({ length: end - start }, (_, i) =>
    `<a style="display:block;height:60px" href="/example_creator/p/Example_${start + i}/">Post</a>`).join('');
  await withPage(url, '<main>' + links(0, 12) + '</main>', async page => {
    const first = await invoke(page, readInstagram, 'profile-step', url, 40, Date.now() + 900, null, 'continued');
    expect(first).toMatchObject({ kind: 'RESEARCH_PROFILE', partial: true, rows: expect.any(Array) });
    const checkpoint = first as { rows: unknown[]; stopReason?: string };
    expect(checkpoint.rows).toHaveLength(12);
    expect(checkpoint.stopReason).toBeUndefined();
    await page.evaluate(extra => document.querySelector('main')?.insertAdjacentHTML('beforeend', extra), links(12, 40));
    const resumed = await invoke(page, readInstagram, 'profile-step', url, 40, Date.now() + 1200, checkpoint, 'continued');
    expect(resumed).toMatchObject({ kind: 'RESEARCH_PROFILE', partial: false });
    expect((resumed as { rows: unknown[] }).rows).toHaveLength(40);
  });
});

it.skipIf(!executablePath)('re-enters the bottom of a stalled Instagram grid and keeps all 24 checkpoint links in order', async () => {
  const url = 'https://www.instagram.com/example_creator/';
  const link = (index: number) => `https://www.instagram.com/p/Bottom_${index}/`;
  const rows = Array.from({ length: 24 }, (_, i) => ({ url: link(i + 1), title: 'Bài Instagram', body: '', captionPartial: true }));
  const tiles = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) =>
    `<a style="display:block;height:72px" href="${link(start + i)}">Post</a>`).join('');
  await withPage(url, `<!doctype html><main>${tiles(1, 24)}</main>`, async page => {
    await page.evaluate(furtherTiles => {
      const root = document.scrollingElement!;
      root.scrollTop = root.scrollHeight;
      let leftBottom = false;
      let loaded = false;
      window.addEventListener('scroll', () => {
        const remaining = root.scrollHeight - root.clientHeight - root.scrollTop;
        if (remaining > 150) leftBottom = true;
        if (remaining <= 2 && leftBottom && !loaded) {
          loaded = true;
          document.querySelector('main')?.insertAdjacentHTML('beforeend', furtherTiles);
        }
      });
    }, tiles(25, 40));
    const checkpoint = { kind: 'RESEARCH_PROFILE', url, rows, partial: true, scrollSteps: 6 };
    const result = await invoke(page, readInstagram, 'profile-step', url, 40, Date.now() + 5500, checkpoint, 'stalled-bottom') as {
      partial: boolean; rows: Array<{ url: string }>;
    };
    expect(result.partial).toBe(false);
    expect(result.rows.map(item => item.url)).toEqual(Array.from({ length: 40 }, (_, i) => link(i + 1)));
  });
});

it.skipIf(!executablePath)('reads the same 40 Instagram links with the worker when page timers are unavailable', async () => {
  const url = 'https://www.instagram.com/example_creator/';
  const postLink = (index: number) => `https://www.instagram.com/p/Worker_${index}/`;
  const tiles = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) =>
    `<a style="display:block;height:50px" href="${postLink(start + i)}">Post</a>`).join('');
  const html = `<!doctype html><main>${tiles(1, 24)}</main><script>
    const root = document.scrollingElement;
    let loaded = false;
    window.addEventListener('scroll', () => {
      if (!loaded && root.scrollHeight - root.clientHeight - root.scrollTop < 3) {
        loaded = true;
        document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(tiles(25, 40))});
      }
    });
  </script>`;
  for (const hidden of [false, true]) await withPage(url, html, async page => {
    if (hidden) await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
      Object.defineProperty(window, 'setTimeout', { value: () => { throw new Error('Page timers unavailable in this fixture'); } });
    });
    const create = vi.fn(async () => ({ id: 1, url, active: false }));
    const update = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      permissions: { contains: async () => true },
      tabs: { query: async () => [], create, update },
      storage: { session: { get: async () => ({}), set: async () => undefined } },
      scripting: { executeScript: async ({ func, args }: { func: Function; args: unknown[] }) =>
        [{ result: await invoke(page, func, ...args) }] },
    });
    try {
      const result = await scanInstagramStep({ id: 'worker-scroll', url, limit: 40 }, Date.now() + 7000, async () => true);
      expect(result.pending).toBe(false);
      expect(result.report.rows.map((item: { url: string }) => item.url)).toEqual(Array.from({ length: 40 }, (_, i) => postLink(i + 1)));
      expect(create).toHaveBeenCalledWith({ url, active: false });
      expect(update.mock.calls).toEqual([[1, { autoDiscardable: false }]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it.skipIf(!executablePath)('publishes a text post only with the selected public audience and finds it after reopening', async () => {
  const url = 'https://www.facebook.com/profile.php?id=' + sender;
  const html = `<!doctype html><main>
    <button id="open">Tạo bài viết</button>
    <div id="draft" role="dialog" hidden>
      <header role="dialog"><h2>Tạo bài viết</h2><button aria-label="Đóng hộp thoại của công cụ tạo">×</button></header>
      <button id="audience">Chỉ mình tôi</button>
      <div id="editor" contenteditable="true" role="textbox" style="min-height:24px"><p><br></p></div>
      <button id="publish">Đăng</button>
    </div>
    <div id="options" role="dialog" hidden><button role="radio" id="public">Công khai Bất kỳ ai</button></div>
    <div id="feed"></div>
  </main>
  <script>
    const read = id => document.getElementById(id);
    read('open').onclick = () => read('draft').hidden = false;
    read('audience').onclick = () => read('options').hidden = false;
    read('public').onclick = () => { read('audience').textContent = 'Công khai'; read('options').hidden = true; };
    read('publish').onclick = () => {
      localStorage.setItem('post', read('editor').innerText.trim());
      localStorage.setItem('clicks', Number(localStorage.getItem('clicks') || 0) + 1);
      read('draft').hidden = true;
    };
    if (localStorage.getItem('post')) {
      read('feed').innerHTML = '<article><h3><a href="${url}">Tác giả</a></h3>'
        + '<a href="/${sender}/posts/987">Vừa xong</a><div data-testid="post_message"></div></article>';
      read('feed').querySelector('[data-testid="post_message"]').textContent = localStorage.getItem('post');
    }
  </script>`;
  await withPage(url, html, async page => {
    const deadline = Date.now() + 20_000;
    const read = async () => (await invoke(page, readResearch, 'publication', url, 8, deadline) as { value: unknown }).value;
    const before = await read();
    expect(await invoke(page, composer, 'prepare', message, deadline, 'PUBLIC')).toBe(true);
    expect(await page.locator('#audience').innerText()).toBe('Công khai');
    await page.evaluate(() => { document.querySelector('#audience')!.textContent = 'Chỉ mình tôi'; });
    expect(await invoke(page, composer, 'commit', message, deadline, 'PUBLIC')).toBe(false);
    expect(await page.evaluate("localStorage.getItem('clicks')")).toBeNull();
    await page.evaluate(() => { document.querySelector('#audience')!.textContent = 'Công khai'; });
    await page.evaluate(() => { document.querySelector('#draft')!.insertAdjacentHTML('beforeend',
      '<div role="dialog" id="other"><h2>Cài đặt</h2><button>Lưu</button></div>'); });
    expect(await invoke(page, composer, 'commit', message, deadline, 'PUBLIC')).toBe(false);
    await page.evaluate(() => { document.querySelector('#other')!.remove(); });
    expect(await invoke(page, composer, 'commit', message, deadline, 'PUBLIC')).toBe(true);
    expect(await invoke(page, composer, 'commit', message, deadline, 'PUBLIC')).toBe(false);
    await page.reload();
    const after = await read();
    expect(findPublishedText(sender, message, before, after)).toEqual({
      externalId: '987', permalink: 'https://www.facebook.com/' + sender + '/posts/987',
    });
    expect(findPublishedText(author, message, before, after)).toBeNull();
    expect(findPublishedText(sender, message, after, after)).toBeNull();
    expect(await page.evaluate("localStorage.getItem('clicks')")).toBe('1');
  });
});

it.skipIf(!executablePath)('finds a text post by exact UID, caption and timestamp in a profile feed and direct post', async () => {
  const profile = 'https://www.facebook.com/profile.php?id=' + sender;
  const permalink = 'https://www.facebook.com/permalink.php?id=' + sender + '&story_fbid=987';
  const seconds = 1795700551;
  const story = (postUrl: string, uid: string, timestamp: number) => ({ permalink_url: postUrl, creation_time: timestamp,
    comet_sections: { content: { story: { comet_sections: { message: { story: { message: { text: message } } } } } },
      context_layout: { story: { actors: [{ id: uid }] } } } });
  const html = '<main></main><script type="application/json">' + JSON.stringify({ feed: [
    story(permalink, sender, seconds),
    story(permalink.replace('987', '988'), author, seconds),
    story(permalink.replace('987', '989'), sender, seconds - 3600),
  ] }) + '</script>';
  for (const url of [profile, permalink]) await withPage(url, html, async page => {
    const from = (seconds - 10) * 1000;
    const until = (seconds + 10) * 1000;
    expect(await invoke(page, readPublicationEvidence, sender, message, from, until, Date.now() + 9_000))
      .toEqual([{ uid: sender, caption: message, createdAt: seconds * 1000, permalink }]);
  });
});

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
