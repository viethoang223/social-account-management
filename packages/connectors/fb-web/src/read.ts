import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { ConnectorError, type ReadConnector, type ReadMedia, type ReadPost, type ReadResult, type SourceRef } from '@seedingsys/connectors-core';
import { legacySourceCode, type ContentType, type IncompleteFlag } from '@seedingsys/contracts';
import type { FbWebOptions } from './config';
import { CHECKPOINT_TEXT, URLS } from './selectors';
import { FB_WEB_VERSION } from './version';
import { parseViTime } from './vi-time';

/**
 * Reads the OWN profile of the account logged into the source's browser profile.
 *
 * Scope, on purpose:
 *  - Only `/me` of the logged-in account, and only if that account IS the configured source
 *    (externalRef = numeric id or vanity name). It never opens other people's profiles.
 *  - Only posts written by the profile owner; comments and commenter names are never read.
 *  - Never logs in or passes a login wall / checkpoint: a person logs in once with `pnpm fb:login N1`.
 *  - No stealth: plain browser, bounded scrolling, polled at the source's interval.
 *
 * Limits: feed images are the size Facebook shows on the profile (not the original upload);
 * videos are not downloadable from the page (they play from stream segments), so video posts are
 * stored with MEDIA_UNAVAILABLE and go to review for a person to attach the file.
 */

const MSG = '[data-ad-preview="message"],[data-ad-comet-preview="message"]';

interface Found {
  idx: number;
  author: string;
  truncated: boolean;
  hasStamp: boolean;
  bigImgs: Array<{ src: string; w: number }>;
  more: number; // "+N" overflow tile
  videos: number;
  shared: boolean;
}

/** Page script (string, no backslashes): tag every post container that has a caption node. */
const TAG_POSTS = `(() => {
  const MSG = '${MSG}';
  const out = [];
  let next = Number(document.body.dataset.ssNext || '0');
  for (const m of Array.from(document.querySelectorAll(MSG))) {
    let box = m;
    for (let i = 0; i < 25; i++) {
      const p = box.parentElement;
      if (!p || p === document.body || p.querySelectorAll(MSG).length > 1) break;
      box = p;
    }
    if (box.closest('[role=dialog]')) continue;
    if (!box.dataset.ssIdx) { box.dataset.ssIdx = String(next++); }
    const idx = Number(box.dataset.ssIdx);
    const head = box.querySelector('h2, h3, h4, strong');
    const author = head ? (head.innerText || '').trim() : '';
    const btn = Array.from(m.querySelectorAll('[role=button]')).find((b) => /xem th/i.test(b.innerText || ''));
    const big = (e) => { const r = e.getBoundingClientRect(); return r.width >= 100 && r.height >= 100; };
    const imgs = Array.from(box.querySelectorAll('a[href*="photo"] img')).filter(big).map((e) => ({ src: e.currentSrc || e.src || '', w: Math.round(e.getBoundingClientRect().width) }));
    let more = 0;
    for (const el of Array.from(box.querySelectorAll('a[href*="photo"] div, a[href*="photo"] span'))) {
      if (el.children.length === 0) { const t = (el.textContent || '').trim(); if (t.charAt(0) === '+' && Number(t.slice(1)) > 0) more = Number(t.slice(1)); }
    }
    const stamp = Array.from(box.querySelectorAll('a[aria-describedby], a[href*="/posts/"], a[href*="story_fbid"], a[href*="pfbid"]')).length > 0;
    out.push({ idx, author, truncated: !!btn, hasStamp: stamp, bigImgs: imgs, more, videos: box.querySelectorAll('video').length, shared: /đã chia sẻ|shared a/i.test(author) });
  }
  document.body.dataset.ssNext = String(next);
  return out;
})()`;

function postIdFrom(href: string): string | null {
  try {
    const u = new URL(href, 'https://www.facebook.com');
    const fbid = u.searchParams.get('story_fbid') ?? u.searchParams.get('fbid');
    if (fbid) return fbid;
    const m = u.pathname.match(/\/(?:posts|videos|permalink)\/([A-Za-z0-9_]+)/);
    if (m) return m[1];
    const p = u.pathname.match(/(pfbid[A-Za-z0-9]+)/);
    return p ? p[1] : null;
  } catch {
    return null;
  }
}

/** "123456" | "ten.nguoi.dung" | "https://www.facebook.com/profile.php?id=123" → canonical lower-case key. */
export function profileKey(ref: string): string {
  const r = ref.trim();
  try {
    if (/^https?:/i.test(r)) {
      const u = new URL(r);
      if (u.pathname.startsWith('/profile.php')) return (u.searchParams.get('id') ?? '').toLowerCase();
      return (u.pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase();
    }
  } catch {
    /* fall through */
  }
  return r.replace(/^@/, '').toLowerCase();
}

export class FbWebReadConnector implements ReadConnector {
  readonly key = 'fb-web';
  readonly version = FB_WEB_VERSION;

  constructor(
    private readonly opts: FbWebOptions,
    private readonly maxPosts = 10,
  ) {}

  profilePath(code: string): string {
    const path = join(this.opts.profilesRoot, basename(code.replace(/\\/g, '/')).replace(/[^\w.-]/g, '_'));
    const previousCode = legacySourceCode(code);
    if (previousCode === code || existsSync(path)) return path;
    const previousPath = join(this.opts.profilesRoot, previousCode);
    return existsSync(previousPath) ? previousPath : path;
  }

  private now() {
    return this.opts.now ? this.opts.now() : new Date();
  }

  async readSince(source: SourceRef, watermark: Record<string, unknown> | null, overlap: number): Promise<ReadResult> {
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(this.profilePath(source.code), {
        headless: this.opts.headless,
        channel: this.opts.channel,
        executablePath: this.opts.executablePath,
        timeout: 15_000,
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
        viewport: { width: 1280, height: 900 },
      });
    } catch (e) {
      throw new ConnectorError('TRANSIENT', `Không mở được profile trình duyệt của nguồn ${source.code}: ${(e as Error).message.split('\n')[0]}`);
    }
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= ctx.close().catch(() => undefined));
    const timer = setTimeout(() => { void close(); }, 90_000);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      page.setDefaultTimeout(this.opts.stepTimeoutMs);
      await page.goto(`${this.opts.baseUrl}/me`, { waitUntil: 'domcontentloaded', timeout: this.opts.stepTimeoutMs * 2 });
      await page.waitForLoadState('load').catch(() => undefined);
      await this.assertOwnProfile(page, source);
      const posts = await this.collect(page, legacySourceCode(source.code), Math.max(this.maxPosts, overlap));
      const newest = posts.reduce((m, p) => Math.max(m, p.postedAt?.getTime() ?? 0), Number((watermark as { newest?: number } | null)?.newest ?? 0));
      return { posts, nextWatermark: { newest }, incomplete: [] };
    } finally {
      clearTimeout(timer);
      await close();
    }
  }

  /** Refuse to read anything unless the logged-in account is exactly the configured source. */
  private async assertOwnProfile(page: Page, source: SourceRef) {
    const url = page.url();
    const body = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) ?? '';
    if (URLS.checkpoint.test(url) || CHECKPOINT_TEXT.test(body.slice(0, 4000))) {
      throw new ConnectorError('SOURCE_UNREADABLE', `Tài khoản nguồn ${source.code} đang bị Facebook yêu cầu xác minh — cần người xử lý (pnpm fb:login ${source.code})`);
    }
    if (URLS.login.test(url) || (await page.locator('input[name="pass"], input[type="password"]').count()) > 0) {
      throw new ConnectorError('SOURCE_UNREADABLE', `Profile của nguồn ${source.code} chưa đăng nhập — chạy: pnpm fb:login ${source.code}`);
    }
    const u = new URL(url);
    const observed = (u.pathname.startsWith('/profile.php') ? (u.searchParams.get('id') ?? '') : (u.pathname.split('/').filter(Boolean)[0] ?? '')).toLowerCase();
    const want = profileKey(source.externalRef);
    if (!want || observed !== want) {
      throw new ConnectorError('SOURCE_UNREADABLE', `Profile của nguồn ${source.code} đang đăng nhập tài khoản "${observed || '?'}", không phải "${want || source.externalRef}". Chỉ đọc được trang cá nhân của chính tài khoản đang đăng nhập.`);
    }
  }

  private async collect(page: Page, sourceCode: string, max: number): Promise<ReadPost[]> {
    const owner = ((await page.locator('h1').first().innerText({ timeout: 4000 }).catch(() => '')) ?? '').trim().toLowerCase();
    const out = new Map<string, ReadPost>();
    const seen = new Set<number>();
    let idle = 0;
    for (let step = 0; step < 12 && out.size < max; step++) {
      const found = ((await page.evaluate(TAG_POSTS).catch(() => [])) as Found[]) ?? [];
      const before = seen.size;
      for (const f of found) {
        if (seen.has(f.idx) || out.size >= max) continue;
        seen.add(f.idx);
        const author = f.author.trim().toLowerCase();
        if (owner && author && !author.startsWith(owner)) continue; // someone else's post on this timeline
        const post = await this.readOne(page, f, sourceCode);
        if (post && !out.has(post.externalId)) out.set(post.externalId, post);
      }
      idle = seen.size > before ? 0 : idle + 1;
      if (idle >= 3 && seen.size > 0) break; // nothing new for a while: end of the recent posts
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(1000);
    }
    return [...out.values()];
  }

  private async readOne(page: Page, f: Found, sourceCode: string): Promise<ReadPost | null> {
    const box = page.locator(`[data-ss-idx="${f.idx}"]`);
    const msg = box.locator(MSG).first();
    const incomplete: IncompleteFlag[] = [];

    if (f.truncated) {
      // "Xem thêm" expands the caption in place (reading only; nothing is posted or sent).
      await msg.getByRole('button', { name: /xem th/i }).first().click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }
    let text = ((await msg.innerText({ timeout: 3000 }).catch(() => '')) ?? '').trim();
    if (/xem thêm$/i.test(text)) {
      incomplete.push('CAPTION_TRUNCATED');
      text = text.replace(/…?\s*xem thêm$/i, '').trim();
    }

    // Facebook fills the timestamp link's real address only when it is hovered.
    let href = '';
    let stampText = '';
    if (f.hasStamp) {
      const stamp = box.locator('a[aria-describedby], a[href*="/posts/"], a[href*="story_fbid"], a[href*="pfbid"]').first();
      await stamp.hover({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      href = (await stamp.getAttribute('href').catch(() => null)) ?? '';
      stampText = ((await stamp.innerText({ timeout: 1500 }).catch(() => '')) ?? '').trim();
      await page.mouse.move(5, 5).catch(() => undefined);
    }
    const postId = href && href !== '#' ? postIdFrom(href) : null;
    const when = stampText ? parseViTime(stampText, this.now()) : null;

    let contentType: ContentType = 'TEXT';
    const media: ReadMedia[] = [];
    if (f.videos > 0) {
      contentType = 'VIDEO';
      incomplete.push('MEDIA_UNAVAILABLE'); // stream-only on the page: a person must attach the file
    } else if (f.bigImgs.length) {
      contentType = f.bigImgs.length + f.more > 1 ? 'MULTI_PHOTO' : 'SINGLE_PHOTO';
      if (f.more > 0) incomplete.push('MEDIA_COUNT_UNKNOWN'); // album larger than what the profile shows
      f.bigImgs.forEach((im, i) => media.push({ kind: 'image', ref: `fbweb-photo:${postId ?? 'x'}:${i}`, sourceUrl: im.src }));
    }
    if (!text && !media.length && contentType !== 'VIDEO') return null;

    const externalId = postId ?? `hash-${createHash('sha256').update(`${sourceCode}|${text}|${f.bigImgs.length}|${f.videos}`).digest('hex').slice(0, 24)}`;
    return {
      externalId,
      identityConfidence: postId ? 'HIGH' : 'LOW',
      permalink: href && href !== '#' ? new URL(href, this.opts.baseUrl).toString() : undefined,
      postedAt: when?.at,
      text,
      contentType,
      isPinned: false,
      isShared: f.shared,
      media,
      incomplete: [...new Set(incomplete)],
      raw: { reader: 'fb-web-own-profile', stamp: stampText || null },
    };
  }

  /** Images are plain CDN URLs: downloaded without the browser and without cookies. */
  async fetchMedia(media: { ref: string; sourceUrl?: string | null }): Promise<{ bytes: Buffer; mime: string }> {
    if (!media.sourceUrl) throw new ConnectorError('PERMANENT', `Không có đường dẫn ảnh cho ${media.ref}`);
    let res: Response;
    try {
      res = await fetch(media.sourceUrl);
    } catch (e) {
      throw new ConnectorError('TRANSIENT', `Tải ảnh lỗi: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ConnectorError(res.status >= 500 ? 'TRANSIENT' : 'PERMANENT', `Tải ảnh lỗi HTTP ${res.status} (đường dẫn ảnh có thể đã hết hạn)`);
    const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
    return { bytes: Buffer.from(await res.arrayBuffer()), mime };
  }
}
