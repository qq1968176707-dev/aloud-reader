import { unzipSync } from 'fflate';

/**
 * The zip layer, shared by the Electron and browser hosts.
 *
 * The importers used to take a file path and hand it to adm-zip, which reaches for
 * `node:fs` at module load and therefore cannot exist in a browser bundle. fflate
 * decompresses from bytes in both runtimes, so the whole parsing side of the app
 * became portable the moment this file replaced it.
 *
 * Only the handful of operations the importers actually performed are kept: list the
 * non-directory entries, read one as bytes, read one as UTF-8.
 */
export interface ZipArchive {
  /** Entry paths, always with forward slashes, directories excluded. */
  names: string[];
  has: (name: string) => boolean;
  read: (name: string) => Uint8Array | null;
  readText: (name: string) => string | null;
}

const decoder = new TextDecoder('utf-8');

export function openZip(data: Uint8Array): ZipArchive {
  // Directories arrive as zero-length entries whose name ends in '/'.
  const raw = unzipSync(data);
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(raw)) {
    if (name.endsWith('/')) continue;
    files.set(name.replace(/\\/g, '/'), bytes);
  }
  return {
    names: [...files.keys()],
    has: (name) => files.has(name),
    read: (name) => files.get(name) ?? null,
    readText: (name) => {
      const bytes = files.get(name);
      return bytes ? decoder.decode(bytes) : null;
    },
  };
}
