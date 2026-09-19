/**
 * electron-builder afterPack hook: complete ad-hoc code signature on macOS.
 *
 * Without a Developer ID, electron-builder is told to skip signing (`identity: null`) —
 * but it still edits the Electron bundle (renames the binary, rewrites Info.plist), which
 * leaves Electron's original ad-hoc seal broken:
 *
 *   codesign -v → code has no resources but signature indicates they must be present
 *
 * A locally built app opens anyway. A DOWNLOADED one is quarantined, and macOS judges a
 * broken seal as "已损坏，无法打开" — no right-click, no "仍要打开", just the bin. Re-signing
 * the whole bundle ad hoc gives it a valid seal, so a downloaded copy gets the ordinary
 * unidentified-developer path instead. Runs before the dmg/zip are made, so every
 * artifact carries the good signature.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed and verified  ${path.basename(app)}`);
};
