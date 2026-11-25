// Also injected into the tab. Keep this function self-contained.
export function facebookIdentity(raw) {
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://www.facebook.com' || url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, '');
    const post = /\/(?:posts|videos|reel)\/([\w]+)$/.exec(path)?.[1]
      ?? (['/story.php', '/permalink.php'].includes(path) ? url.searchParams.get('story_fbid') : null)
      ?? (['/photo', '/photo.php'].includes(path) ? url.searchParams.get('fbid') : null)
      ?? (path === '/watch' ? url.searchParams.get('v') : null);
    if (post && /^[\w]{1,200}$/.test(post)) return 'post:' + post;
    const profile = path === '/profile.php' ? url.searchParams.get('id') : /^\/people\/[^/]+\/(\d+)$/.exec(path)?.[1];
    if (profile && /^\d+$/.test(profile)) return 'uid:' + profile;
    if (/^\/[\w.]+$/.test(path) && !/^\/(?:login|checkpoint|home\.php|watch|reels?|groups|photo|profile\.php|me)$/i.test(path)) {
      return 'profile:' + path.toLowerCase();
    }
    return null;
  } catch { return null; }
}
