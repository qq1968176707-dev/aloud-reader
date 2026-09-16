/**
 * Browser storage for the iPad build.
 *
 * The desktop app keeps everything as files under userData. The web build keeps the
 * same shapes in the Origin Private File System, which is the only browser storage
 * that is both large enough for book packages and persistent on iOS once the page has
 * been added to the Home Screen.
 *
 * The layout mirrors the desktop one deliberately, so the two hosts can be reasoned
 * about together:
 *
 *   settings.json · library.json · stats/reading.json
 *   books/<bookId>/book.json · plain.json · chapters/*.html · images/*
 *   state/<bookId>.json · annotations/<bookId>.json · ink/<bookId>.json
 *   ink/<bookId>/<file>            pictures pasted onto the ink layer
 *   recordings/<bookId>/<id>.wav   + <id>.json sidecar
 */

const rootPromise: Promise<FileSystemDirectoryHandle> = navigator.storage.getDirectory();

export const opfsAvailable = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

/** Walk (and optionally create) a directory path like `books/abc/chapters`. */
async function dir(path: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  let handle = await rootPromise;
  for (const part of path.split('/').filter(Boolean)) {
    try {
      handle = await handle.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return handle;
}

const split = (path: string): [string, string] => {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? ['', path] : [path.slice(0, cut), path.slice(cut + 1)];
};

async function fileHandle(path: string, create = false): Promise<FileSystemFileHandle | null> {
  const [parent, name] = split(path);
  const d = await dir(parent, create);
  if (!d) return null;
  try {
    return await d.getFileHandle(name, { create });
  } catch {
    return null;
  }
}

export async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const h = await fileHandle(path);
  if (!h) return null;
  try {
    return new Uint8Array(await (await h.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

export async function readText(path: string): Promise<string | null> {
  const h = await fileHandle(path);
  if (!h) return null;
  try {
    return await (await h.getFile()).text();
  } catch {
    return null;
  }
}

export async function writeBytes(path: string, data: Uint8Array | string): Promise<void> {
  const h = await fileHandle(path, true);
  if (!h) throw new Error(`无法写入 ${path}`);
  const w = await h.createWritable();
  // TypeScript 5.7 made Uint8Array generic over its backing buffer, and the DOM types
  // for OPFS still demand a plain ArrayBuffer. At run time any ArrayBufferView is
  // accepted, and nothing in this app produces a SharedArrayBuffer-backed view, so the
  // narrowing happens once here rather than at every call site.
  await w.write(data as FileSystemWriteChunkType);
  await w.close();
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readText(path);
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const writeJson = (path: string, value: unknown): Promise<void> =>
  writeBytes(path, `${JSON.stringify(value, null, 2)}\n`);

export async function remove(path: string, recursive = false): Promise<void> {
  const [parent, name] = split(path);
  const d = await dir(parent);
  if (!d) return;
  try {
    await d.removeEntry(name, { recursive });
  } catch {
    /* already gone */
  }
}

export async function list(path: string): Promise<string[]> {
  const d = await dir(path);
  if (!d) return [];
  const names: string[] = [];
  // @ts-expect-error — `keys()` is present on every engine that ships OPFS.
  for await (const name of d.keys()) names.push(name as string);
  return names;
}

export async function exists(path: string): Promise<boolean> {
  return (await fileHandle(path)) != null || (await dir(path)) != null;
}

/**
 * Ask iOS to stop evicting us.
 *
 * Safari grants persistence to sites the user has added to the Home Screen, which is
 * exactly how this build is meant to be installed; without it a long gap between
 * reading sessions can clear the library.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function usage(): Promise<{ usedBytes: number; quotaBytes: number }> {
  try {
    const est = await navigator.storage.estimate();
    return { usedBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0 };
  } catch {
    return { usedBytes: 0, quotaBytes: 0 };
  }
}

export const P = {
  settings: () => 'settings.json',
  library: () => 'library.json',
  stats: () => 'stats/reading.json',
  bookDir: (id: string) => `books/${id}`,
  manifest: (id: string) => `books/${id}/book.json`,
  plain: (id: string) => `books/${id}/plain.json`,
  chapterFile: (id: string, file: string) => `books/${id}/chapters/${file}`,
  state: (id: string) => `state/${id}.json`,
  annotations: (id: string) => `annotations/${id}.json`,
  ink: (id: string) => `ink/${id}.json`,
  inkImagesDir: (id: string) => `ink/${id}`,
  recordingsDir: (id: string) => `recordings/${id}`,
};
