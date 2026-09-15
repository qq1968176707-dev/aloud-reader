/** Production build: renderer via Vite -> dist/, main+preload via esbuild -> dist-electron/. */
import esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import { rm } from 'node:fs/promises';
import { mainOptions, preloadOptions } from './esbuild.common.mjs';

await rm('dist', { recursive: true, force: true });
await rm('dist-electron', { recursive: true, force: true });

await esbuild.build(mainOptions(false));
await esbuild.build(preloadOptions(false));
await viteBuild({ configFile: 'vite.config.ts', mode: 'production' });

console.log('\nBuild complete -> dist/ + dist-electron/');
