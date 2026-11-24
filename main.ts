// mend: one patch tool for every AI edit format (acct3 build).
//
// Architecture: PER-FORMAT DIRECT APPLIERS. Each of the four formats has its
// own parser and its own apply functions that work straight on the tree's
// line model; there is no shared edit IR. Only small helpers are shared:
// safe paths, patch line splitting, the file line model, and the tier
// matcher as a standalone function. Sections 1-4, 9 and 10 follow the
// kit starter's behaviour (command line, output and exit codes, safe paths,
// format detection, JSON edits, all-or-nothing write). Sections 5-8
// (three-tier matching, unified diffs, SEARCH/REPLACE blocks, V4A patches)
// are implemented here. Node 22, standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// File line model (shared small helper). A file's break is CRLF when its
// first line feed follows a carriage return, LF otherwise.
// ---------------------------------------------------------------------------

interface LineModel {
  br: string;
  lines: string[];
  final: boolean;
}

function toModel(text: string): LineModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function fromModel(m: LineModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Tier matcher (standalone shared helper, SPEC section 5).
// ---------------------------------------------------------------------------

function eqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (!eqAtTier(lines[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(lines: string[], old: string[], strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrencesAt(lines, old, t, from).length > 0) return t;
  }
  return -1;
}

// First tier with an occurrence that also passes `keep` (used by V4A
// end-of-file chunks, whose occurrence must end at the file's last line:
// the tier is chosen among the qualifying occurrences, not among all).
function firstTierWhere(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
  keep: (pos: number) => boolean,
): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrencesAt(lines, old, t, from).some(keep)) return t;
  }
  return -1;
}

// Build the replacement lines for a match at `pos`: a context line of N is
// the file's own matched line; at tier 2 every other line of N is
// re-indented from the old first line's leading whitespace to the file's.
function spliceLines(
  fileLines: string[],
  pos: number,
  fresh: string[],
  ctx: (number | null)[],
  oldFirst: string,
  tier: number,
): string[] {
  if (tier === 2) {
    const p = leadWs(oldFirst);
    const f = leadWs(fileLines[pos] ?? '');
    return fresh.map((ln, j) => {
      const ci = ctx[j];
      if (ci !== null && ci !== undefined) return fileLines[pos + ci]!;
      if (ln !== '' && !/^[ \t]+$/.test(ln) && ln.startsWith(p)) return f + ln.slice(p.length);
      return ln;
    });
  }
  return fresh.map((ln, j) => {
    const ci = ctx[j];
    return ci !== null && ci !== undefined ? fileLines[pos + ci]! : ln;
  });
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it (shared): changed paths in `now`
// (null: deleted), the rest read from disk.
// ---------------------------------------------------------------------------

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;
type Hooks = { move: (oldP: string, newP: string) => void };

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9). One edit object, or null when it is not one.
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6). Own parser, own applier.
// ---------------------------------------------------------------------------

interface UniHunk {
  a: number;
  O: string[];
  N: string[];
  Nctx: (number | null)[];
  noNL: boolean;
  plus: string[];
  plusNoNL: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  dashPair: boolean;
  creation: boolean;
  deletion: boolean;
  hunks: UniHunk[];
}

// The path after `--- ` / `+++ `: text after the four characters, up to the
// first tab, surrounding spaces removed, one leading a/ or b/ removed.
function diffPath(raw: string): string {
  const up = raw.split('\t')[0] ?? '';
  const t = up.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUniHunk(a: number, raw: string[]): UniHunk {
  interface BodyEntry {
    kind: 'ctx' | 'old' | 'new';
    text: string;
    noNL: boolean;
  }
  const entries: BodyEntry[] = [];
  for (const bl of raw) {
    if (bl.startsWith('\\')) {
      if (entries.length > 0) entries[entries.length - 1]!.noNL = true;
      continue;
    }
    if (bl === '') {
      entries.push({ kind: 'ctx', text: '', noNL: false });
      continue;
    }
    const c = bl[0]!;
    if (c === ' ') entries.push({ kind: 'ctx', text: bl.slice(1), noNL: false });
    else if (c === '-') entries.push({ kind: 'old', text: bl.slice(1), noNL: false });
    else if (c === '+') entries.push({ kind: 'new', text: bl.slice(1), noNL: false });
  }
  const O: string[] = [];
  const N: string[] = [];
  const Nctx: (number | null)[] = [];
  const plus: string[] = [];
  let plusNoNL = false;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      Nctx.push(O.length);
      O.push(e.text);
      N.push(e.text);
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else {
      N.push(e.text);
      Nctx.push(null);
      plus.push(e.text);
      plusNoNL = e.noNL;
    }
  }
  let noNL = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k]!;
    if (e.kind === 'ctx' || e.kind === 'new') {
      noNL = e.noNL;
      break;
    }
  }
  return { a, O, N, Nctx, noNL, plus, plusNoNL };
}

function applyUniHunk(model: LineModel, h: UniHunk, strict: boolean, path: string, d: number): void {
  if (h.O.length > 0) {
    const tier = firstTier(model.lines, h.O, strict, 0);
    if (tier < 0) throw new Fail('no-match', path);
    const spots = occurrencesAt(model.lines, h.O, tier, 0);
    const target = h.a - 1 + d;
    let best = spots[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of spots) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.O.length === model.lines.length;
    const fresh = spliceLines(model.lines, best, h.N, h.Nctx, h.O[0]!, tier);
    model.lines.splice(best, h.O.length, ...fresh);
    if (atEnd) model.final = !h.noNL;
  } else {
    const ins = Math.max(0, Math.min(h.a + d, model.lines.length));
    const atEnd = ins === model.lines.length;
    model.lines.splice(ins, 0, ...h.N);
    if (atEnd) model.final = !h.noNL;
  }
}

function uniSectionEdit(s: UniSection, strict: boolean, hooks: Hooks): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP === null || s.creation) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noNL = false;
      for (const h of s.hunks) {
        if (h.plus.length > 0) noNL = h.plusNoNL;
        plus.push(...h.plus);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (newP === null || s.deletion) {
      if (oldP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = toModel(cur);
    let d = 0;
    for (const h of s.hunks) {
      applyUniHunk(model, h, strict, oldP, d);
      d += h.N.length - h.O.length;
    }
    const text = fromModel(model);
    if (isMove) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      hooks.move(oldP, newP);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean, hooks: Hooks): Edit[] {
  const sections: UniSection[] = [];
  let section: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const openSection = (oldP: string | null, newP: string | null): UniSection => {
    const s: UniSection = { oldPath: oldP, newPath: newP, dashPair: false, creation: false, deletion: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const devNull = (p: string): string | null => (p === '/dev/null' ? null : p);
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)[ \t]*$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      section = openSection(m[1]!, m[2]!);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = devNull(diffPath(line.slice(4)));
      const np = devNull(diffPath(lines[i + 1]!.slice(4)));
      if (section !== null && inHeader) {
        section.oldPath = op;
        section.newPath = np;
        section.dashPair = true;
      } else {
        section = openSection(op, np);
        section.dashPair = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (section !== null && inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (section !== null && inHeader && line.startsWith('+++ ')) {
      section.newPath = devNull(diffPath(line.slice(4)));
      i++;
      continue;
    }
    if (section !== null && inHeader && line.startsWith('rename from ')) {
      if (!section.dashPair) section.oldPath = line.slice(12).trim();
      i++;
      continue;
    }
    if (section !== null && inHeader && line.startsWith('rename to ')) {
      if (!section.dashPair) section.newPath = line.slice(10).trim();
      i++;
      continue;
    }
    if (section !== null && inHeader && line.startsWith('new file mode')) {
      section.creation = true;
      i++;
      continue;
    }
    if (section !== null && inHeader && line.startsWith('deleted file mode')) {
      section.deletion = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = parseInt(m[1]!, 10);
      const raw: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          raw.push(bl);
          j++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      section.hunks.push(parseUniHunk(a, raw));
      i = j;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniSectionEdit(s, strict, hooks));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7). Own parser, own applier.
// ---------------------------------------------------------------------------

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = toModel(cur);
    const tier = firstTier(model.lines, oldLines, strict, 0);
    if (tier < 0) throw new Fail('no-match', path);
    const spots = occurrencesAt(model.lines, oldLines, tier, 0);
    if (spots.length > 1) throw new Fail('ambiguous', path);
    const pos = spots[0]!;
    const fresh = spliceLines(model.lines, pos, newLines, newLines.map(() => null), oldLines[0]!, tier);
    model.lines.splice(pos, oldLines.length, ...fresh);
    tree.now.set(path, fromModel(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '=======' && eq === -1) eq = j;
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8). Own parser, own applier.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: string[];
  Nctx: (number | null)[];
}

function findAnchor(lines: string[], from: number, anchor: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (eqAtTier(lines[k]!, anchor, t)) return k;
    }
  }
  return -1;
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, hooks: Hooks): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = toModel(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const apos = findAnchor(model.lines, cursor, ch.anchor, strict);
        if (apos < 0) throw new Fail('no-match', path);
        cursor = apos + 1;
      }
      if (ch.O.length === 0) {
        const ins = ch.eof ? model.lines.length : cursor;
        model.lines.splice(ins, 0, ...ch.N);
        cursor = ins + ch.N.length;
      } else {
        const keep = (p: number): boolean => !ch.eof || p + ch.O.length === model.lines.length;
        const tier = firstTierWhere(model.lines, ch.O, strict, cursor, keep);
        if (tier < 0) throw new Fail('no-match', path);
        const spots = occurrencesAt(model.lines, ch.O, tier, cursor).filter(keep);
        if (spots.length === 0) throw new Fail('no-match', path);
        const pos = spots[0]!;
        const fresh = spliceLines(model.lines, pos, ch.N, ch.Nctx, ch.O[0]!, tier);
        model.lines.splice(pos, ch.O.length, ...fresh);
        cursor = pos + ch.N.length;
      }
    }
    const text = fromModel(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      hooks.move(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4A(lines: string[], strict: boolean, hooks: Hooks): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (blank(l)) {
          fileLines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      interface ChunkEntry {
        kind: 'ctx' | 'old' | 'new';
        text: string;
      }
      let cur: { anchor: string | null; eof: boolean; entries: ChunkEntry[] } | null = null;
      const finish = (strip: boolean): void => {
        if (cur === null) return;
        if (strip) {
          while (cur.entries.length > 0) {
            const e = cur.entries[cur.entries.length - 1]!;
            if (e.kind === 'ctx' && e.text === '') cur.entries.pop();
            else break;
          }
        }
        const O: string[] = [];
        const N: string[] = [];
        const Nctx: (number | null)[] = [];
        for (const e of cur.entries) {
          if (e.kind === 'ctx') {
            Nctx.push(O.length);
            O.push(e.text);
            N.push(e.text);
          } else if (e.kind === 'old') {
            O.push(e.text);
          } else {
            N.push(e.text);
            Nctx.push(null);
          }
        }
        chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N, Nctx });
        cur = null;
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          finish(false);
          cur = { anchor: l.slice(2).trim(), eof: false, entries: [] };
          i++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          finish(false);
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { anchor: null, eof: false, entries: [] };
          if (l === '') cur.entries.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.entries.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.entries.push({ kind: 'old', text: l.slice(1) });
          else cur.entries.push({ kind: 'new', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finish(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict, hooks));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Run one invocation (SPEC sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const hooks: Hooks = {
    move: (o, n) => {
      moves.push([o, n]);
    },
  };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, hooks);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict, hooks);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of moves) {
    const co = changed.get(o);
    const cn = changed.get(n);
    if (co && cn && co.was !== null && co.now === null && cn.was === null && cn.now !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
