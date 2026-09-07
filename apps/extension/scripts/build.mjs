import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'build');
const watch = process.argv.includes('--watch') ? {} : undefined;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const [name, format] of [['page', 'iife'], ['content', 'iife'], ['amazonNotice', 'iife'], ['background', 'es']]) {
  await build({
    root,
    configFile: false,
    build: {
      emptyOutDir: false,
      outDir,
      sourcemap: true,
      watch,
      lib: {
        entry: resolve(root, `src/${name}.ts`),
        name: name === 'page'
          ? 'TeeReplayPage'
          : name === 'content'
            ? 'TeeReplayContent'
            : name === 'amazonNotice'
              ? 'TeeReplayAmazonNotice'
              : undefined,
        formats: [format],
        fileName: () => `${name}.js`,
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

await cp(resolve(root, 'src/manifest.json'), resolve(outDir, 'manifest.json'));
await cp(resolve(root, 'src/popup.html'), resolve(outDir, 'popup.html'));
