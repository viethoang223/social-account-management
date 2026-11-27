function mediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) return null;
  url.hash = '';
  return url.href;
}

export function readInstagramEmbed(html, shortcode) {
  if (!/^[\w-]{1,32}$/.test(shortcode) || html.length > 2_000_000) return null;
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script.includes(shortcode) || !script.includes('edge_media_to_caption')) continue;
    for (const [literal] of script.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
      if (!literal.includes(shortcode) || !literal.includes('edge_media_to_caption')) continue;
      let data;
      try { data = JSON.parse(JSON.parse(literal)); }
      catch { continue; }
      const pending = [data];
      for (let visited = 0; pending.length && visited < 20_000; visited++) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        if (item.shortcode === shortcode && item.edge_media_to_caption && typeof item.__typename === 'string') {
          const captionEdges = item.edge_media_to_caption.edges;
          const caption = captionEdges?.[0]?.node?.text ?? (Array.isArray(captionEdges) && !captionEdges.length ? '' : null);
          const commentCount = item.edge_media_to_comment?.count;
          const sidecar = item.edge_sidecar_to_children;
          const carousel = item.__typename === 'GraphSidecar' || Boolean(sidecar);
          const nodes = carousel ? (Array.isArray(sidecar?.edges) ? sidecar.edges.map(edge => edge?.node) : null) : [item];
          const count = carousel ? (sidecar?.count ?? nodes?.length) : 1;
          const media = Array.isArray(nodes) ? nodes.flatMap(node => {
            const video = node?.is_video === true || node?.__typename === 'GraphVideo';
            const image = node?.display_url ?? node?.display_resources?.at(-1)?.src;
            const url = mediaUrl(video ? node?.video_url : image);
            return url ? [{ kind: video ? 'video' : 'image', url }] : [];
          }) : [];
          const declaredMediaCount = Number.isSafeInteger(count) && count >= (carousel ? 2 : 1) && count <= 20 ? count : null;
          const mediaProof = declaredMediaCount !== null && media.length === declaredMediaCount && !sidecar?.page_info?.has_next_page;
          return { caption: typeof caption === 'string' && caption.length <= 16_000 ? caption : null,
            mediaId: typeof item.id === 'string' && /^\d{8,32}$/.test(item.id) ? item.id : null,
            comments: Number.isSafeInteger(commentCount) && commentCount >= 0 ? commentCount : null,
            video: item.is_video === true ? mediaUrl(item.video_url) : null,
            ...(mediaProof && { media, declaredMediaCount }), ...(carousel && { carousel, declaredMediaCount }) };
        }
        for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
      }
    }
  }
  return null;
}

export async function fetchInstagramEmbed(raw, fetcher = fetch) {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  const match = /^\/(p|reel|tv)\/([\w-]{1,32})\/?$/.exec(url.pathname);
  if (url.origin !== 'https://www.instagram.com' || url.username || url.password || !match) return null;
  try {
    const response = await fetcher(`https://www.instagram.com/${match[1]}/${match[2]}/embed/`, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8500),
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 2_000_000) {
      await response.body?.cancel();
      return null;
    }
    return readInstagramEmbed(await response.text(), match[2]);
  } catch {
    return null;
  }
}

// Read only the exact opened post through the existing signed-in Instagram session.
export async function readInstagramNativeMedia(mediaId, shortcode) {
  const onPost = () => location.origin === 'https://www.instagram.com'
    && /^\/(?:[\w.]{1,30}\/)?(?:p|reels?|tv)\/([\w-]{1,32})\/?$/.exec(location.pathname)?.[1] === shortcode;
  if (!onPost()) return null;
  if (!mediaId) {
    const appLink = document.querySelector('meta[property="al:ios:url"],meta[property="al:android:url"]')?.content;
    if (appLink && URL.canParse(appLink)) {
      const url = new URL(appLink);
      if (url.protocol === 'instagram:' && url.hostname === 'media') mediaId = url.searchParams.get('id');
    }
  }
  if (!/^\d{8,32}$/.test(mediaId ?? '')) return null;
  const bestUrl = candidates => {
    if (!Array.isArray(candidates)) return null;
    for (const version of [...candidates].sort((a, b) => (b?.width ?? 0) - (a?.width ?? 0))) {
      if (typeof version?.url !== 'string' || version.url.length > 2048 || !URL.canParse(version.url)) continue;
      const link = new URL(version.url);
      if (link.protocol === 'https:' && !link.port && !link.username && !link.password
        && /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(link.hostname)) return link.href;
    }
    return null;
  };
  try {
    const response = await fetch(`/api/v1/media/${mediaId}/info/`, { credentials: 'same-origin', redirect: 'error',
      headers: { 'X-IG-App-ID': '936619743392459', accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
    if (!response.ok || !onPost() || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) return null;
    const body = await response.json();
    const item = body.items?.find(item => String(item.pk ?? item.id ?? '').split('_')[0] === mediaId && item.code === shortcode);
    if (!item || ![1, 2, 8].includes(item.media_type)) return null;
    const carousel = item.media_type === 8;
    const nodes = carousel ? item.carousel_media : [item];
    const declaredMediaCount = carousel ? item.carousel_media_count ?? nodes?.length : 1;
    if (!Array.isArray(nodes) || nodes.length !== declaredMediaCount || nodes.length < (carousel ? 2 : 1) || nodes.length > 20) return null;
    const media = nodes.flatMap(node => {
      if (![1, 2].includes(node?.media_type)) return [];
      const video = node.media_type === 2;
      const url = bestUrl(video ? node.video_versions : node.image_versions2?.candidates);
      return url ? [{ kind: video ? 'video' : 'image', url }] : [];
    });
    const caption = item.caption === null ? '' : item.caption?.text;
    if (media.length === declaredMediaCount && onPost()) return { media, declaredMediaCount, carousel,
      ...(typeof caption === 'string' && caption.length <= 16_000 && { caption }),
      ...(media.length === 1 && media[0].kind === 'video' && { video: media[0].url }) };
  } catch {}
  return null;
}
