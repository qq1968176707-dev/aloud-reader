/**
 * Dev launcher: esbuild (watch) for main+preload, Vite dev server for the renderer,
 * and an Electron process that is restarted whenever the main process code changes.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import esbuild from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { mainOptions, preloadOptions } from './esbuild.common.mjs';

let child = null;
let restarting = false;

function startElectron(devServerUrl) {
  if (child) {
    restarting = true;
    child.kill();
    child = null;
  }
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, ELECTRON_ENABLE_LOGGING: '1' },
  });
  child.on('exit', (code) => {
    if (restarting) {
      restarting = false;
      return;
    }
    process.exit(code ?? 0);
  });
}

const restartPlugin = (label, onRebuild) => ({
  name: `restart-${label}`,
  setup(build) {
    let first = true;
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (first) {
        first = false;
        return;
      }
      onRebuild();
    });
  },
});

const server = await createServer({ configFile: 'vite.config.ts', mode: 'development' });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;
server.printUrls();

const restart = () => startElectron(url);

const mainCtx = await esbuild.context({
  ...mainOptions(true),
  plugins: [restartPlugin('main', restart)],
});
const preloadCtx = await esbuild.context({
  ...preloadOptions(true),
  plugins: [restartPlugin('preload', restart)],
});

await mainCtx.watch();
await preloadCtx.watch();
startElectron(url);

const shutdown = async () => {
  restarting = true;
  child?.kill();
  await mainCtx.dispose();
  await preloadCtx.dispose();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
