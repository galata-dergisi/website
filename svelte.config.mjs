import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const deprecationPattern = /deprecated/i;

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    discloseVersion: false,
    runes: true,
  },
  onwarn(warning, defaultHandler) {
    if (
      String(warning.code).includes('deprecated')
      || deprecationPattern.test(warning.message)
    ) {
      throw new Error(`${warning.code}: ${warning.message}`);
    }
    defaultHandler(warning);
  },
};
