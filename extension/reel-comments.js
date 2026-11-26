/** Opens the current Reel's comment panel in the extension's isolated world. */
export async function openReelComments(requested, deadline) {
  const expected = new URL(requested);
  const path = expected.pathname.replace(/\/+$/, '');
  const here = () => Date.now() < deadline && expected.origin === 'https://www.facebook.com'
    && location.origin === expected.origin && location.pathname.replace(/\/+$/, '') === path;
  if (!/^\/reel\/[\w]+$/.test(path) || !here()) return false;

  const visible = element => element.getClientRects().length && !element.closest('[aria-hidden="true"]');
  const all = (scope, selector) => [...scope.querySelectorAll(selector)].filter(visible);
  const heading = 'h1,h2,h3,h4,[role="heading"]';
  const editor = '[role="textbox"][contenteditable="true"]';
  const ancestor = (element, predicate) => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      if (predicate(node)) return node;
    }
    return null;
  };
  const panelForReel = () => {
    const panels = new Set(all(document, heading)
      .filter(node => /^(?:Bình luận|Comments)$/i.test(node.textContent.trim()))
      .map(node => ancestor(node, area => all(area, editor).length === 1 && all(area, 'video').length === 0))
      .filter(Boolean));
    return panels.size === 1 ? [...panels][0] : null;
  };
  const waitFor = async find => {
    const end = Math.min(deadline, Date.now() + 7000);
    while (here() && Date.now() < end) {
      const found = find();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 160));
    }
    return null;
  };
  const onScreen = button => {
    const bounds = button.getBoundingClientRect();
    const x = (bounds.left + bounds.right) / 2;
    const y = (bounds.top + bounds.bottom) / 2;
    return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
      && button.contains(document.elementFromPoint(x, y));
  };
  const reelToggle = () => {
    const controls = all(document, 'button,[role="button"]').filter(button => {
      const label = button.getAttribute('aria-label')?.trim() ?? '';
      if (!/^(?:Bình luận|Comments?)(?:,\s*\d[\d.,\s]*\s*[KMB]?(?:\s*(?:bình luận|comments?))?)?$/i.test(label)
        || !onScreen(button)) return false;
      const player = ancestor(button, area => all(area, 'video').length > 0);
      return player && all(player, 'video').length === 1;
    });
    return controls.length === 1 ? controls[0] : null;
  };

  let panel = panelForReel();
  if (!panel) {
    const toggle = await waitFor(reelToggle);
    if (!toggle || !here()) return false;
    toggle.click();
    panel = await waitFor(panelForReel);
  }
  if (!panel || !here()) return false;

  // The author header is next to the comments, outside the main video region.
  const content = ancestor(panel, area => all(area, 'video').length === 0
    && all(area, heading).some(node => node.querySelector('a[href]'))) ?? panel;
  globalThis.__seedingReelComments = { path, panel, content };
  return true;
}
