/**
 * Renders build/icon.html to build/icon.png (1024²), build/icon.icns (macOS) and
 * build/icon.ico (Windows).
 *
 * Electron is the renderer because it is already a dependency and it rasterises the SVG
 * exactly as the app's own Chromium would; `iconutil` (macOS) then packs the iconset.
 *
 *   node scripts/make-icon.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electronPath from 'electron';

const here = path.resolve('build');
const mainFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'aloud-icon-')), 'main.cjs');
writeFileSync(
  mainFile,
  `const { app, BrowserWindow } = require('electron');
   const fs = require('node:fs');
   app.whenReady().then(async () => {
     const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false });
     await win.loadFile(${JSON.stringify(path.join(here, 'icon.html'))});
     await new Promise((r) => setTimeout(r, 400));
     const image = await win.webContents.capturePage();
     fs.writeFileSync(${JSON.stringify(path.join(here, 'icon.png'))}, image.toPNG());
     app.exit(0);
   });`,
);

const render = spawn(electronPath, [mainFile], { stdio: 'inherit' });
render.on('exit', (code) => {
  rmSync(path.dirname(mainFile), { recursive: true, force: true });
  if (code) process.exit(code);
  console.log('wrote build/icon.png');
  if (process.platform !== 'darwin') return; // sips/iconutil are macOS tools

  // iconset: every size macOS asks for, downscaled from the 1024 master by sips.
  const iconset = path.join(here, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  spawnSync('mkdir', ['-p', iconset]);
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    for (const [name, px] of [
      [`icon_${size}x${size}.png`, size],
      [`icon_${size / 2}x${size / 2}@2x.png`, size],
    ]) {
      if (size === 16 && name.includes('@2x')) continue;
      if (px > 1024) continue;
      spawnSync('sips', ['-z', String(px), String(px), path.join(here, 'icon.png'), '--out', path.join(iconset, name)], {
        stdio: 'ignore',
      });
    }
  }
  spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(here, 'icon.icns')], { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
  console.log('wrote build/icon.icns');

  // Windows .ico. Since Vista an ICO entry may be a whole PNG file, so the container is
  // a 6-byte header plus one 16-byte directory entry per size — no BMP encoding needed.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aloud-ico-'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((px) => {
    const file = path.join(tmp, `${px}.png`);
    spawnSync('sips', ['-z', String(px), String(px), path.join(here, 'icon.png'), '--out', file], { stdio: 'ignore' });
    return { px, data: readFileSync(file) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ px, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(px >= 256 ? 0 : px, 0); // 0 means 256
    e.writeUInt8(px >= 256 ? 0 : px, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  writeFileSync(path.join(here, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  rmSync(tmp, { recursive: true, force: true });
  console.log('wrote build/icon.ico');
});
