import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const edition = process.env.ALOUD_EDITION === 'lite' ? 'lite' : 'pro';

export default defineConfig({
  // 'lite' = 不含声音克隆的版本（见 src/main/edition.ts）
  define: { __ALOUD_EDITION__: JSON.stringify(edition) },
  // Production is served from the custom `aloud://app/` scheme, so assets must be relative.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@': r('./src/renderer'),
    },
  },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
  },
});
