import { defineConfig } from 'vitepress';
import { currentVersion } from '../scripts/site-version.mjs';

const SITE_ORIGIN = 'https://aid-framework.github.io';
const BASE = '/aid-framework/';
const REPOSITORY = 'https://github.com/aid-framework/aid-framework';

/**
 * The footer names the latest release tag, not a hand-edited string. Tags are absent from a
 * shallow clone, and the deployment fetches them precisely so the published footer can be
 * checked against `git tag`; when they are missing the version is omitted rather than guessed.
 */
const latestRelease = currentVersion();

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
  title: 'AID Framework',
  description:
    'A declarative spec for AI services: one YAML file compiled to Python and TypeScript services that you own.',
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
    // URL that never resolves. It is already excluded from the sitemap.
    if (/(^|\/)404\.md$/.test(pageData.relativePath)) return [];
    return [['link', { rel: 'canonical', href: canonicalUrl(pageData.relativePath) }]];
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
