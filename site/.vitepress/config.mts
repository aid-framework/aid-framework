import { defineConfig } from 'vitepress';

/**
 * The content root is the repository's `docs/` directory, so `design.md` has exactly
 * one copy: the site renders it where it already lives instead of owning a duplicate.
 */
export default defineConfig({
  title: 'AID Framework',
  description:
    'A declarative spec for AI services: one YAML file compiled to Python and TypeScript services that you own.',
  lang: 'en-GB',
  base: '/aid-framework/',
  srcDir: '../docs',
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/aid-framework/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#0b1020' }],
  ],
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
      message: 'Released under the MIT licence.',
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
