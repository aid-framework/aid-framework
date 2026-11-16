<script setup lang="ts">
/**
 * The `aid visualize` picture, drawn in the browser from a spec the visitor supplies.
 *
 * It compiles the spec here rather than sending it anywhere: `visualDocumentFrom` is the same
 * read-then-lower path `aid validate` runs, so the page reports the same diagnostics with the
 * same codes, and a spec the build would refuse is refused here too. The alternative -- a
 * parser loose enough to draw anything -- would produce convincing diagrams of services that
 * cannot be generated, which is the one failure mode this framework exists to prevent.
 *
 * The served page is embedded in an iframe because its stylesheet owns global selectors
 * (`html`, `body`, `header`) that would otherwise restyle the documentation around it.
 */

import capabilities from 'virtual:aid-capabilities';
import samples from 'virtual:aid-samples';
import { visualDocumentFrom } from '@aid-visualize/document';
import { renderPage } from '@aid-visualize/page';
import { onMounted, ref } from 'vue';

type Status = { kind: 'empty' | 'drawn' | 'refused'; text: string };
type Sample = (typeof samples)[number];

const DEFAULT_SAMPLE = 'warranty-claims';
const DEBOUNCE_MS = 600;

const source = ref('');
const specPath = ref('app.spec.yaml');
const srcdoc = ref('');
const status = ref<Status>({
  kind: 'empty',
  text: 'Load an example or paste a specification to draw it.',
});
const failure = ref<string | null>(null);
const frameTitle = ref('Spec visualisation');

let pending: ReturnType<typeof setTimeout> | undefined;

function draw(text: string, path: string): void {
  if (text.trim() === '') {
    srcdoc.value = '';
    failure.value = null;
    status.value = { kind: 'empty', text: 'Load an example or paste a specification to draw it.' };
    return;
  }
  let document: ReturnType<typeof visualDocumentFrom>;
  try {
    document = visualDocumentFrom(text, path, capabilities);
  } catch (error) {
    // The gates report a refusal as diagnostics; reaching this means the input was not a spec
    // at all, which still has to be said out loud rather than left as a blank frame.
    failure.value = error instanceof Error ? error.message : String(error);
    srcdoc.value = '';
    status.value = { kind: 'refused', text: 'The specification could not be read.' };
    return;
  }
  failure.value = null;
  srcdoc.value = renderPage({ document });
  frameTitle.value = `Spec visualisation of ${path}`;
  status.value = document.ok
    ? {
        kind: 'drawn',
        text:
          `${document.counts.nodes} nodes, ${document.counts.edges} edges, ` +
          `${document.counts.systems} systems, ${document.counts.steps} steps` +
          (document.warnings.length > 0 ? `, ${document.warnings.length} warning(s)` : ''),
      }
    : {
        kind: 'refused',
        text:
          `The build refuses this specification: ${document.diagnostics.length} ` +
          `diagnostic(s). Each one names the fix.`,
      };
}

function load(sample: Sample): void {
  source.value = sample.yaml;
  specPath.value = sample.specPath;
  draw(sample.yaml, sample.specPath);
}

// The three handlers below are referenced only from the template, which Biome does not
// analyse, so it reports them as unused. Same suppression as `Layout.vue` uses for
// `DefaultLayout`.
// biome-ignore lint/correctness/noUnusedVariables: the template references this handler.
function onInput(): void {
  clearTimeout(pending);
  pending = setTimeout(() => draw(source.value, specPath.value), DEBOUNCE_MS);
}

// biome-ignore lint/correctness/noUnusedVariables: the template references this handler.
async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  specPath.value = file.name;
  source.value = await file.text();
  draw(source.value, specPath.value);
  // Cleared so that choosing the same file again still fires a change event.
  input.value = '';
}

// biome-ignore lint/correctness/noUnusedVariables: the template references this handler.
function onSample(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const sample = samples.find((candidate) => candidate.id === select.value);
  select.value = '';
  if (sample !== undefined) load(sample);
}

onMounted(() => {
  const sample = samples.find((candidate) => candidate.id === DEFAULT_SAMPLE) ?? samples[0];
  if (sample !== undefined) load(sample);
});
</script>

<template>
  <div class="aid-visualizer">
    <div class="av-controls">
      <div class="av-source">
        <label for="aid-visualizer-spec">Specification</label>
        <textarea
          id="aid-visualizer-spec"
          v-model="source"
          spellcheck="false"
          autocomplete="off"
          aria-describedby="aid-visualizer-hint"
          @input="onInput"
        />
        <p id="aid-visualizer-hint" class="av-hint">
          Nothing leaves this page. The specification is parsed and gated by the same code the
          CLI runs, compiled into the diagram locally.
        </p>
      </div>
      <div class="av-actions">
        <button type="button" class="av-button" @click="draw(source, specPath)">
          Visualise
        </button>
        <label for="aid-visualizer-file" class="av-label">Upload a spec</label>
        <input
          id="aid-visualizer-file"
          type="file"
          accept=".yaml,.yml,text/yaml,application/yaml"
          @change="onFile"
        />
        <label for="aid-visualizer-sample" class="av-label">Or load an example</label>
        <select id="aid-visualizer-sample" @change="onSample">
          <option value="">Choose an example specification</option>
          <option v-for="sample in samples" :key="sample.id" :value="sample.id">
            {{ sample.label }}
          </option>
        </select>
        <p class="av-status" :data-kind="status.kind" role="status" aria-live="polite">
          {{ status.text }}
        </p>
        <p v-if="failure !== null" class="av-failure">{{ failure }}</p>
      </div>
    </div>
    <iframe v-if="srcdoc !== ''" class="av-frame" :srcdoc="srcdoc" :title="frameTitle" />
  </div>
</template>

<style scoped>
.aid-visualizer {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin: 1.5rem 0;
}

.av-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18rem;
  gap: 1rem;
}

.av-source {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.av-source textarea {
  width: 100%;
  height: 16rem;
  resize: vertical;
  padding: 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  line-height: 1.5;
  tab-size: 2;
}

.av-actions {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.av-label,
.av-source label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.av-button {
  align-self: flex-start;
  padding: 0.45rem 1rem;
  border: 1px solid var(--vp-button-brand-border);
  border-radius: 8px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.av-button:hover {
  border-color: var(--vp-button-brand-hover-border);
  background: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}

.av-actions input[type='file'],
.av-actions select {
  width: 100%;
  font: inherit;
  font-size: 0.8rem;
  color: var(--vp-c-text-1);
}

.av-actions select {
  padding: 0.3rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.av-hint,
.av-status,
.av-failure {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.av-status[data-kind='drawn'] {
  color: var(--vp-c-brand-1);
}

.av-status[data-kind='refused'],
.av-failure {
  color: var(--vp-c-danger-1);
}

.av-failure {
  font-family: var(--vp-font-family-mono);
}

.av-frame {
  width: 100%;
  height: clamp(32rem, 78vh, 60rem);
  border: 0;
  border-radius: 10px;
  background: #0a0f1e;
}

@media (max-width: 860px) {
  .av-controls {
    grid-template-columns: minmax(0, 1fr);
  }

  .av-frame {
    height: 80vh;
  }
}
</style>
