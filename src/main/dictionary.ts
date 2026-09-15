import fs from 'node:fs';
import { P } from './paths';
import type { DictEntry } from '@shared/types';

/**
 * Fully offline, deliberately tiny. The point is the *interaction* (double-click a word
 * and get a card without leaving the page); the corpus is the user's to supply.
 *
 * Drop a `dictionary.json` in the data directory to extend it:
 *   { "ephemeral": { "phonetic": "/ɪˈfem(ə)rəl/", "defs": ["adj. 短暂的，转瞬即逝的"] } }
 */
type RawDict = Record<string, { phonetic?: string; defs: string[] }>;

const BUILTIN: RawDict = {
  ephemeral: { phonetic: '/ɪˈfem(ə)rəl/', defs: ['adj. 短暂的；朝生暮死的'] },
  luminous: { phonetic: '/ˈluːmɪnəs/', defs: ['adj. 发光的；明亮的；清晰易懂的'] },
  solitude: { phonetic: '/ˈsɒlɪtjuːd/', defs: ['n. 独处；隐居；人迹罕至之地'] },
  threshold: { phonetic: '/ˈθreʃhəʊld/', defs: ['n. 门槛；阈值；开端'] },
  cadence: { phonetic: '/ˈkeɪd(ə)ns/', defs: ['n. 节奏；抑扬顿挫；（乐）终止式'] },
  render: { phonetic: '/ˈrendə(r)/', defs: ['v. 使成为；给予；渲染；表达'] },
  anchor: { phonetic: '/ˈæŋkə(r)/', defs: ['n. 锚；支柱', 'v. 抛锚；使固定'] },
  margin: { phonetic: '/ˈmɑːdʒɪn/', defs: ['n. 页边空白；边缘；余地；利润'] },
  paginate: { phonetic: '/ˈpædʒɪneɪt/', defs: ['v. 给…标页码；分页'] },
  annotate: { phonetic: '/ˈænəteɪt/', defs: ['v. 注释；批注'] },
  '朗读': { defs: ['lǎng dú — 清晰响亮地把文字念出来。'] },
  '批注': { defs: ['pī zhù — 在书页上写下的评点与注解。'] },
  '书签': { defs: ['shū qiān — 夹在书里标记阅读位置的薄片。'] },
};

let userDict: RawDict = {};
let userDictAt = 0;

function loadUserDict(): RawDict {
  try {
    const stat = fs.statSync(P.dictionary());
    if (stat.mtimeMs !== userDictAt) {
      userDict = JSON.parse(fs.readFileSync(P.dictionary(), 'utf8')) as RawDict;
      userDictAt = stat.mtimeMs;
    }
  } catch {
    userDict = {};
    userDictAt = 0;
  }
  return userDict;
}

const stems = (word: string): string[] => {
  const w = word.toLowerCase();
  const out = [w];
  if (w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.endsWith('s')) out.push(w.slice(0, -1));
  if (w.endsWith('ed')) out.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith('ing')) out.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
  return out;
};

export function lookup(word: string): DictEntry | null {
  const trimmed = word.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!trimmed) return null;
  const user = loadUserDict();
  for (const key of [trimmed, ...stems(trimmed)]) {
    const hit = user[key] ?? user[key.toLowerCase()];
    if (hit) return { word: key, phonetic: hit.phonetic, defs: hit.defs, source: 'dictionary.json' };
  }
  for (const key of [trimmed, ...stems(trimmed)]) {
    const hit = BUILTIN[key] ?? BUILTIN[key.toLowerCase()];
    if (hit) return { word: key, phonetic: hit.phonetic, defs: hit.defs, source: '内置词表' };
  }
  return null;
}
