import { defineConfig } from 'vitepress';
import { currentVersion } from '../scripts/site-version.mjs';

const SITE_ORIGIN = 'https://aid-framework.github.io';
const BASE = '/aid-framework/';
const REPOSITORY = 'https://github.com/aid-framework/aid-framework';

const SITE_NAME = 'AID Framework';

/**
 * The fallback description, used by the homepage and by any page that forgets to declare
 * one. It is the site's own tagline, so a page that renders it in `og:description` is
 * describing the project rather than the page it is on; `scripts/check-head.mjs` fails a
 * non-home page that does exactly that.
 */
const SITE_DESCRIPTION =
  'A declarative spec for AI services: one YAML file compiled to Python and TypeScript services that you own.';

/**
 * The footer names the version the shipped manifests declare, not a hand-edited string and
 * not the newest tag: tags `v0.1.40`-`v0.1.43` exist without a release. `currentVersion()`
 * returns `null` when the manifests disagree, and the footer then omits the version rather
 * than claiming one.
 */
const latestRelease = currentVersion();

/**
 * The bare version the homepage states, and the token it appears as in the Markdown.
 * `unknown` is the honest fallback when `currentVersion()` cannot name one, because the
 * shipped manifests disagree rather than being absent.
 */
const shippedVersion = latestRelease === null ? 'unknown' : latestRelease.replace(/^v/, '');
const VERSION_TOKEN = /\{\{\s*AID_VERSION\s*\}\}/g;

/**
 * Licence, notice and security policy are linked to their repository copies, which stay the
 * single source of truth; the site never restates their text.
 */
const LEGAL_LINKS = [
  `<a href="${REPOSITORY}/blob/main/LICENSE">Licence</a>`,
  `<a href="${REPOSITORY}/blob/main/NOTICE">Notice</a>`,
  `<a href="${REPOSITORY}/blob/main/SECURITY.md">Security</a>`,
].join(' · ');

/**
 * GitHub Pages serves `/guide/concepts` and `/guide/concepts.html` for the same
 * file, and `/` and `/index.html` likewise. `cleanUrls` decides which links
 * VitePress emits; it does not stop the server accepting the other form. Without
 * a canonical tag each page is reachable at two URLs, and a crawler is free to
 * index the duplicate — so every page declares which URL is authoritative.
 */
function canonicalUrl(relativePath: string): string {
  const page = relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
  return `${SITE_ORIGIN}${BASE}${page}`;
}

/**
 * The content root is the repository's `docs/` directory, so `design.md` has exactly
 * one copy: the site renders it where it already lives instead of owning a duplicate.
 */
export default defineConfig({
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  lang: 'en-GB',
  base: BASE,
  srcDir: '../docs',
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/aid-framework/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#0b1020' }],
    [
      'meta',
      {
        name: 'google-site-verification',
        content: 'URgYOLgzCY-V-CbXInuNNyseZdk3NOCpVA5K6nTz9Mw',
      },
    ],
  ],
  transformHead({ pageData }) {
    // The generated 404 page is not addressable, so a canonical would point at a
    // URL that never resolves. It is already excluded from the sitemap, and it has
    // no title or description worth sharing.
    if (/(^|\/)404\.md$/.test(pageData.relativePath)) return [];

    const url = canonicalUrl(pageData.relativePath);
    const isHome = /(^|\/)index\.md$/.test(pageData.relativePath);
    const pageTitle = typeof pageData.title === 'string' ? pageData.title.trim() : '';
    const title =
      pageTitle === '' || pageTitle === SITE_NAME ? SITE_NAME : `${pageTitle} | ${SITE_NAME}`;
    const declared = pageData.frontmatter.description;
    const description =
      typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : SITE_DESCRIPTION;

    return [
      ['link', { rel: 'canonical', href: url }],
      // Open Graph and Twitter card tags. Without them a shared link renders as a bare
      // URL: the crawler keeps the page title and finds no summary, or scrapes body text
      // that starts mid-sentence. `twitter:card` is `summary` rather than
      // `summary_large_image` because the site ships no social preview image, and a card
      // that promises an image it does not have renders worse than one that does not.
      ['meta', { property: 'og:type', content: isHome ? 'website' : 'article' }],
      ['meta', { property: 'og:site_name', content: SITE_NAME }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:locale', content: 'en_GB' }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
    ];
  },
  /**
   * VitePress's appearance switch names itself in `onMounted`, from
   * `themeConfig.lightModeSwitchTitle` / `darkModeSwitchTitle`, and it sets only
   * `title` — never `aria-label`. Until the theme hydrates, the emitted button is
   * an unnamed `role="switch"`, which is what a screen reader reaches if the script
   * has not run. Naming it in the HTML makes the name part of the document instead
   * of a side effect of hydration; `title` keeps the hover hint, and `aria-label`
   * wins over it for assistive technology.
   */
  transformHtml(html) {
    return (
      html
        .replace(
          /(<button class="VPSwitch VPSwitchAppearance"[^>]*?role="switch")/g,
          '$1 aria-label="Switch colour theme"',
        )
        /**
         * The home layout renders its content straight into `<div class="VPContent">`,
         * while a content page gets a real `<main>` inside it. The homepage therefore had
         * no main landmark, and the only `<article>` elements on it are feature cards, so a
         * landmark rule that accepted `article` passed on the cards and hid the gap.
         *
         * `role="main"` on the wrapper makes the skip link's `#VPContent` target an actual
         * landmark. It is limited to the home variant because on a content page the same
         * wrapper also holds the sidebar and the outline.
         */
        .replace(/(<div class="VPContent is-home" id="VPContent")/g, '$1 role="main"')
    );
  },
  // The trailing slash on `hostname` is load-bearing. VitePress emits page paths
  // without a leading slash (`guide/getting-started`), and the sitemap library
  // resolves them with `new URL(path, hostname)`. Without the slash the base
  // directory is treated as a file and `/aid-framework/` is dropped from every
  // URL; with a leading-slash path it would be dropped too.
  sitemap: {
    hostname: `${SITE_ORIGIN}${BASE}`,
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/spec' },
      { text: 'Walkthroughs', link: '/walkthroughs/support-copilot' },
      { text: 'Design', link: '/design' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Writing a spec', link: '/guide/writing-a-spec' },
            { text: 'The generated tree', link: '/guide/generated-tree' },
            { text: 'Serving an app', link: '/guide/serving' },
            { text: 'Concepts', link: '/guide/concepts' },
          ],
        },
        {
          text: 'Concepts in depth',
          items: [
            { text: 'Spec to IR', link: '/guide/spec-to-ir' },
            { text: 'IR to generator', link: '/guide/ir-to-generator' },
            { text: 'Generator to runtime', link: '/guide/generator-to-runtime' },
            { text: 'Runtime to CLI', link: '/guide/runtime-to-cli' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Spec', link: '/reference/spec' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Targets', link: '/reference/targets' },
            { text: 'Eval metrics', link: '/reference/eval-metrics' },
            { text: 'Conformance', link: '/reference/conformance' },
          ],
        },
      ],
      '/walkthroughs/': [
        {
          text: 'Walkthroughs',
          items: [
            { text: 'Support copilot', link: '/walkthroughs/support-copilot' },
            { text: 'Guarded reply', link: '/walkthroughs/guarded-reply' },
          ],
        },
      ],
      '/': [
        {
          text: 'Start here',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Troubleshooting', link: '/troubleshooting' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Spec', link: '/reference/spec' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Targets', link: '/reference/targets' },
            { text: 'Eval metrics', link: '/reference/eval-metrics' },
            { text: 'Conformance', link: '/reference/conformance' },
          ],
        },
        {
          text: 'Project',
          items: [
            { text: 'Design document', link: '/design' },
            { text: 'Contributing', link: '/contributing' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    editLink: {
      pattern: 'https://github.com/aid-framework/aid-framework/edit/main/docs/:path',
      text: 'Edit this page',
    },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: [
        latestRelease === null ? null : `Latest release ${latestRelease}`,
        'Released under the Apache-2.0 licence',
        LEGAL_LINKS,
      ]
        .filter((part) => part !== null)
        .join(' · '),
      copyright: 'AID Framework contributors',
    },
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    /**
     * Substitute the release version into the prose. A Vue interpolation would not work:
     * Vite's `define` does not reach a render function generated from Markdown, so the
     * token would render as empty text. Replacing the text token keeps the output literal.
     */
    config(md) {
      md.core.ruler.push('aid-version', (state) => {
        for (const token of state.tokens) {
          if (token.type !== 'inline' || token.children === null) continue;
          for (const child of token.children) {
            if (child.type !== 'text') continue;
            child.content = child.content.replaceAll(VERSION_TOKEN, shippedVersion);
          }
        }
        return true;
      });
    },
  },
  vite: {
    server: {
      fs: {
        // The content root sits one level above the VitePress project root.
        allow: ['..'],
      },
    },
  },
});
