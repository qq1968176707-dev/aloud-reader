/** Zips samples/sample-book/ into samples/sample-book.zip so it can be imported by the app. */
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const src = path.join(root, 'samples', 'sample-book');
const out = path.join(root, 'samples', 'sample-book.zip');

const zip = new AdmZip();
zip.addLocalFolder(src);
zip.writeZip(out);
console.log('wrote', out);
