<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { onMounted, onUnmounted } from 'vue';

import { installA11y } from './a11y';

// biome-ignore lint/correctness/noUnusedVariables: the template references this, which Biome does not analyse.
const DefaultLayout = DefaultTheme.Layout;

let uninstall: (() => void) | undefined;

onMounted(() => {
  uninstall = installA11y();
});

onUnmounted(() => {
  uninstall?.();
});
</script>

<template>
  <DefaultLayout />
</template>
