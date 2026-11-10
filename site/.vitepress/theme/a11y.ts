/**
 * Post-hydration accessibility behaviour the default theme does not provide.
 *
 * The HTML gate (`check-a11y.mjs`) reads the document a browser receives; axe, run by
 * `check-browser-a11y.mjs`, judges the rendered page but only in the state it finds.
 * What is left is behaviour: where focus goes when the search dialog or the mobile
 * navigation opens and closes, and whether the visible shortcut hint is part of the
 * control's accessible name. None of that exists until Vue mounts, so it is installed
 * here rather than in `transformHtml`.
 *
 * Every write is guarded by a comparison. The `MutationObserver` watches `childList`
 * changes and `sync()` runs from its callback, so an unconditional `setAttribute` would
 * retrigger the observer on every pass and starve the browser.
 */

const SEARCH_BUTTON = '.DocSearch-Button';
const SEARCH_KEYS = '.DocSearch-Button-Keys';
const SEARCH_DIALOG = '.VPLocalSearchBox';
const NAV_SCREEN = '.VPNavScreen';
const NAV_TOGGLE = '.VPNavBarHamburger';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * `aria-keyshortcuts` spells modifiers out (`Control`, `Meta`); the keycap renders the
 * platform's own glyph, which the name cannot reproduce.
 */
const SEARCH_SHORTCUT = IS_APPLE ? 'Meta+K' : 'Control+K';

/**
 * @param {HTMLElement} element
 * @returns {boolean} whether the element has a rendered box.
 */
function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/**
 * @param {ParentNode} root
 * @returns {HTMLElement[]} focusable descendants in document order.
 */
function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
}

/**
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
function find(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

/**
 * VitePress renders the shortcut keycaps directly after the "Search" placeholder with no
 * whitespace between them, so the two text nodes concatenate to `SearchK` in the
 * accessibility tree. Insert a space once, and keep the keycaps out of the name so the
 * shortcut is announced by `aria-keyshortcuts` instead of as a stray letter.
 */
function syncSearchButton(): void {
  const button = find(SEARCH_BUTTON);
  if (button === null) return;

  const keys = button.querySelector<HTMLElement>(SEARCH_KEYS);
  if (keys !== null) {
    const previous = keys.previousSibling;
    const separated =
      previous !== null &&
      previous.nodeType === Node.TEXT_NODE &&
      /\s/.test(previous.textContent ?? '');
    if (!separated) keys.before(document.createTextNode(' '));
    if (keys.getAttribute('aria-hidden') !== 'true') keys.setAttribute('aria-hidden', 'true');
  }

  if (button.getAttribute('aria-keyshortcuts') !== SEARCH_SHORTCUT) {
    button.setAttribute('aria-keyshortcuts', SEARCH_SHORTCUT);
  }

  // `innerText` rather than `textContent`: the placeholder is hidden below 768px, and
  // WCAG 2.5.3 compares the name against the text a sighted reader actually sees.
  // biome-ignore lint/performance/useDomNodeTextContent: the hidden placeholder must not count as visible.
  const visible = button.innerText.replace(/\s+/g, ' ').trim();
  const label = visible === '' ? 'Search' : `${visible} (${SEARCH_SHORTCUT})`;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
}

/**
 * Installs the behaviours and returns a cleanup function.
 *
 * @returns {() => void}
 */
export function installA11y(): () => void {
  let searchOpen = false;
  let searchChosen = false;
  let navOpen = false;
  let focusBeforeDialog: HTMLElement | null = null;
  let scheduled = false;

  function onFocusIn(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(SEARCH_DIALOG) !== null) return;
    focusBeforeDialog = target;
  }

  function onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`${SEARCH_DIALOG} .result`) !== null) searchChosen = true;
  }

  function onKeyDown(event: KeyboardEvent): void {
    const screen = find(NAV_SCREEN);
    if (screen === null) return;

    if (event.key === 'Escape') {
      const toggle = find(NAV_TOGGLE);
      if (toggle === null) return;
      event.preventDefault();
      // Drive the theme's own state rather than writing `aria-expanded` here: the
      // hamburger binds it to the same ref that decides whether the panel is mounted,
      // so duplicating the value is how the two drift apart.
      toggle.click();
      toggle.focus();
      return;
    }

    if (event.key !== 'Tab') return;

    const toggle = find(NAV_TOGGLE);
    const order = toggle === null ? focusables(screen) : [toggle, ...focusables(screen)];
    if (order.length === 0) return;

    const first = order[0];
    const last = order[order.length - 1];
    const active = document.activeElement;
    const insidePanel = active instanceof Node && screen.contains(active);

    if (event.shiftKey && (active === first || (!insidePanel && active !== toggle))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function sync(): void {
    syncSearchButton();

    const dialog = find(SEARCH_DIALOG);
    if (dialog !== null && !searchOpen) {
      searchOpen = true;
      searchChosen = false;
    } else if (dialog === null && searchOpen) {
      searchOpen = false;
      const restore =
        !searchChosen &&
        focusBeforeDialog !== null &&
        focusBeforeDialog.isConnected &&
        (document.activeElement === null || document.activeElement === document.body);
      if (restore) focusBeforeDialog?.focus();
    }

    const screen = find(NAV_SCREEN);
    if (screen !== null && !navOpen) {
      navOpen = true;
      focusables(screen)[0]?.focus();
    } else if (screen === null && navOpen) {
      navOpen = false;
      const toggle = find(NAV_TOGGLE);
      // Escape and the toggle's own click already leave focus in the right place; this
      // only rescues focus when the panel closed some other way (a route change, a
      // resize across the breakpoint) and dropped it on `<body>`.
      if (
        toggle !== null &&
        (document.activeElement === null || document.activeElement === document.body)
      ) {
        toggle.focus();
      }
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      sync();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown);

  sync();

  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown);
  };
}
