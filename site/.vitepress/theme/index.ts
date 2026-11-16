import DefaultTheme from 'vitepress/theme';
import { defineAsyncComponent } from 'vue';

import './custom.css';
import Layout from './Layout.vue';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    // Registered globally rather than imported per page: a markdown page cannot import a
    // component, and `docs/visualize.md` stays markdown so the link, head and accessibility
    // checks keep applying to it.
    //
    // Async on purpose. The visualiser carries the real validator, the gates and the layout
    // engine, which is most of a megabyte, and a static import would put that in the theme
    // chunk that every page of this site loads. Only `/visualize` renders the component, so
    // only `/visualize` pays for it.
    app.component(
      'AidVisualizer',
      defineAsyncComponent(() => import('./AidVisualizer.vue')),
    );
  },
};
