// mend — one patch tool for every AI edit format (SPEC.md, version 1).
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// mend reads a patch in one of four formats — a unified diff (whose line numbers may be wrong), SEARCH/REPLACE
// blocks, a V4A patch, or JSON tool calls — finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, standard library alone.
//
// When MAKEFUN_ENV_URL is set the process is not a CLI run but a trial: the last lines of this file hand over to
// runner.ts, which reads the trial's checks from the env and runs this same file on each one without the variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A parse fault: the run answers `error: parse <line>` and exit 2. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed: the run answers `error: <code> <path>` for it and, in the end, exit 1. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** A safe path (section 3): relative, `/`-separated, no empty, `.` or `..` segment, no backslash. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!isSafe(p)) throw new EditFault('unsafe', p);
}

/** A file as lines: its own line break, the lines without breaks, and whether the text ends with a break. */
interface FileBody {
  brk: string;
  lines: string[];
  tail: boolean;
}

function splitBody(text: string): FileBody {
  if (text === '') return { brk: '\n', lines: [], tail: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(brk);
  const tail = text.endsWith(brk);
  if (tail) lines.pop();
  return { brk, lines, tail };
}

function joinBody(b: FileBody): string {
  if (b.lines.length === 0) return '';
  return b.lines.join(b.brk) + (b.tail ? b.brk : '');
}

/**
 * The tree as the edits leave it. `state` holds every path an edit has touched (null: deleted); any other path
 * is read from disk, once, and remembered in `base`. Moves a successful edit made are listed in `moves`.
 */
class Tree {
  private readonly base = new Map<string, string | null>();
  readonly state = new Map<string, string | null>();
  moves: Array<readonly [string, string]> = [];

  original(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p)!;
  }

  get(p: string): string | null {
    return this.state.has(p) ? this.state.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.state.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

// ---- Matching lines (section 5) ----

/** Tier transforms: 0 exact, 1 trailing spaces/tabs ignored, 2 leading ones ignored too. */
function atTier(line: string, tier: number): string {
  if (tier === 0) return line;
  const noTrail = line.replace(/[ \t]+$/, '');
  return tier === 1 ? noTrail : noTrail.replace(/^[ \t]+/, '');
}

/** Every start index at or after `from` where pat's lines match lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  if (pat.length === 0 || pat.length > lines.length) return hits;
  const want = pat.map((p) => atTier(p, tier));
  outer: for (let i = Math.max(0, from); i + pat.length <= lines.length; i += 1) {
    for (let j = 0; j < pat.length; j += 1) {
      if (atTier(lines[i + j]!, tier) !== want[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

/** The first tier (0 only when strict) at which pat occurs at or after `from`, with its occurrences there. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; hits: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const hits = occurrences(lines, pat, tier, from);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/** One line of a replacement: either a context line (its index in the old lines) or a new line of the patch. */
interface Seg {
  text: string;
  ctx: number;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/**
 * The lines a match writes. A context line is written as the file's own matched line; at tier 2 every other
 * line is re-indented: its share of the old lines' first line's indent (P) is replaced by the file's (F).
 */
function buildNew(matched: string[], segs: Seg[], tier: number, oldFirst: string): string[] {
  const f = leadWs(matched[0] ?? '');
  const p = leadWs(oldFirst);
  return segs.map((s) => {
    if (s.ctx >= 0) return matched[s.ctx]!;
    if (tier !== 2) return s.text;
    if (s.text === '' || s.text.trim() === '') return s.text;
    return s.text.startsWith(p) ? f + s.text.slice(p.length) : s.text;
  });
}

// ---- Unified diffs (section 6) ----

/** One hunk body line. `bare` marks a line that was empty in the patch (an empty context line). */
interface BodyLine {
  kind: string; // ' ', '-', '+' or '\\'
  text: string;
  bare: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  hdrOld?: string | null; // null: /dev/null
  hdrNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: text up to the first tab, spaces removed, a leading a/ or b/ removed. */
function headerPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;

  const diffGit = (l: string): boolean => l.startsWith('diff --git ');
  const pairAt = (k: number): boolean => lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');

  while (i < lines.length) {
    const l = lines[i]!;
    if (diffGit(l)) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new ParseFault(i + 1);
      cur = { gitOld: m[1]!, gitNew: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (cur === null || !inHeader || cur.hdrOld !== undefined) {
        cur = { create: false, del: false, hunks: [] };
        sections.push(cur);
      }
      cur.hdrOld = headerPath(l.slice(4));
      cur.hdrNew = headerPath(lines[i + 1]!.slice(4));
      inHeader = true;
      i += 2;
      continue;
    }
    if (inHeader && cur !== null && l.startsWith('--- ')) throw new ParseFault(i + 2);
    if (l.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new ParseFault(i + 1);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (diffGit(bl) || pairAt(i)) break;
        const c = bl[0];
        if (bl === '') hunk.body.push({ kind: ' ', text: '', bare: true });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') hunk.body.push({ kind: c, text: bl.slice(1), bare: false });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.bare) hunk.body.pop();
      continue;
    }
    if (inHeader && cur !== null) {
      const rf = /^rename from (.*)$/.exec(l);
      const rt = /^rename to (.*)$/.exec(l);
      if (rf !== null) cur.renameFrom = rf[1]!.split('\t')[0]!.trim();
      else if (rt !== null) cur.renameTo = rt[1]!.split('\t')[0]!.trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1; // prose between sections and hunks is ignored
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfter(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') return body[k + 1]?.kind === '\\';
  }
  return false;
}

/** Apply one hunk to a file body; returns the change in line count. Throws no-match. */
function applyHunk(body: FileBody, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const old: string[] = [];
  const segs: Seg[] = [];
  for (const b of hunk.body) {
    if (b.kind === ' ') {
      segs.push({ text: b.text, ctx: old.length });
      old.push(b.text);
    } else if (b.kind === '-') old.push(b.text);
    else if (b.kind === '+') segs.push({ text: b.text, ctx: -1 });
  }
  if (old.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), body.lines.length);
    const add = segs.map((s) => s.text);
    body.lines.splice(at, 0, ...add);
    if (at === body.lines.length - add.length && add.length > 0) body.tail = !backslashAfter(hunk.body);
    return add.length;
  }
  const found = findTier(body.lines, old, strict);
  if (found === null) throw new EditFault('no-match', path);
  const target = hunk.a - 1 + d;
  let at = found.hits[0]!;
  for (const h of found.hits) if (Math.abs(h - target) < Math.abs(at - target)) at = h;
  const matched = body.lines.slice(at, at + old.length);
  const write = buildNew(matched, segs, found.tier, old[0]!);
  const runsToEnd = at + old.length === body.lines.length;
  body.lines.splice(at, old.length, ...write);
  if (runsToEnd && write.length > 0) body.tail = !backslashAfter(hunk.body);
  return write.length - old.length;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldRaw = s.hdrOld !== undefined ? s.hdrOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newRaw = s.hdrNew !== undefined ? s.hdrNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const isCreate = s.create || oldRaw === null;
  const isDelete = s.del || newRaw === null;
  return (tree) => {
    if (isCreate) {
      const target = (typeof newRaw === 'string' ? newRaw : oldRaw) as string;
      needSafe(target);
      if (tree.get(target) !== null) throw new EditFault('exists', target);
      const texts: string[] = [];
      const flat: BodyLine[] = [];
      for (const h of s.hunks) {
        flat.push(...h.body);
        for (const b of h.body) if (b.kind === '+') texts.push(b.text);
      }
      let lastPlus = -1;
      flat.forEach((b, k) => {
        if (b.kind === '+') lastPlus = k;
      });
      const noBreak = lastPlus >= 0 && flat[lastPlus + 1]?.kind === '\\';
      tree.set(target, texts.length === 0 ? '' : texts.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = (typeof oldRaw === 'string' ? oldRaw : newRaw) as string;
      needSafe(target);
      if (tree.get(target) === null) throw new EditFault('missing', target);
      tree.set(target, null);
      return;
    }
    const from = oldRaw as string;
    const to = newRaw as string;
    needSafe(from);
    if (to !== from) needSafe(to);
    const before = tree.get(from);
    if (before === null) throw new EditFault('missing', from);
    if (to !== from && tree.get(to) !== null) throw new EditFault('exists', to);
    const body = splitBody(before);
    let d = 0;
    for (const h of s.hunks) d += applyHunk(body, h, d, strict, from);
    tree.set(to, joinBody(body));
    if (to !== from) {
      tree.set(from, null);
      tree.moves.push([from, to] as const);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    const oldLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') throw new ParseFault(searchLine + 1);
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new ParseFault(searchLine + 1);
    const newLines: string[] = [];
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new ParseFault(searchLine + 1);
    let path: string | undefined;
    for (let m = searchLine - 1; m >= prevEnd; m -= 1) {
      const t = lines[m]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new ParseFault(searchLine + 1);
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: Block, strict: boolean): Edit {
  return (tree) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFault('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new EditFault('missing', b.path);
    const body = splitBody(before);
    const found = findTier(body.lines, b.oldLines, strict);
    if (found === null) throw new EditFault('no-match', b.path);
    if (found.hits.length > 1) throw new EditFault('ambiguous', b.path);
    const at = found.hits[0]!;
    const matched = body.lines.slice(at, at + b.oldLines.length);
    const segs = b.newLines.map((t) => ({ text: t, ctx: -1 }));
    body.lines.splice(at, b.oldLines.length, ...buildNew(matched, segs, found.tier, b.oldLines[0]!));
    tree.set(b.path, joinBody(body));
  };
}

// ---- V4A patches (section 8) ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  fileLines: string[];
  moveTo?: string;
  chunks: Chunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  // Blank lines at the end of a section (empty or only whitespace, section 4) are not part of it: mark every
  // blank line that directly precedes a section start or the End Patch line, and skip those while parsing.
  const dropped = new Set<number>();
  {
    let pending: number[] = [];
    for (let k = first + 1; k < last; k += 1) {
      const l = lines[k]!;
      if (isBlank(l)) {
        pending.push(k);
        continue;
      }
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) {
        for (const p of pending) dropped.add(p);
      }
      pending = [];
    }
    for (const p of pending) dropped.add(p);
  }

  const sectionAt = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };
  const pathOf = (l: string): string => l.slice(l.indexOf(':') + 1).trim();

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionAt(l);
    if (kind === null) throw new ParseFault(i + 1);
    const sec: VSection = { kind, path: pathOf(l), line: i + 1, fileLines: [], chunks: [] };
    sections.push(sec);
    i += 1;
    if (kind === 'add') {
      const held: Array<{ text: string; bare: boolean }> = [];
      while (i < last && sectionAt(lines[i]!) === null) {
        if (dropped.has(i)) {
          i += 1;
          continue;
        }
        const bl = lines[i]!;
        if (bl.startsWith('+')) held.push({ text: bl.slice(1), bare: false });
        else if (bl === '') held.push({ text: '', bare: true });
        else throw new ParseFault(i + 1);
        i += 1;
      }
      while (held.length > 0 && held[held.length - 1]!.bare) held.pop();
      sec.fileLines = held.map((h) => h.text);
    } else if (kind === 'delete') {
      while (i < last && sectionAt(lines[i]!) === null) {
        if (!isBlank(lines[i]!)) throw new ParseFault(i + 1);
        i += 1;
      }
    } else {
      let chunk: Chunk | null = null;
      let eofClosed = false;
      let firstLine = true;
      while (i < last && sectionAt(lines[i]!) === null) {
        if (dropped.has(i)) {
          i += 1;
          continue;
        }
        const bl = lines[i]!;
        if (firstLine && bl.startsWith('*** Move to:')) {
          sec.moveTo = pathOf(bl);
          i += 1;
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (bl.trim() === '*** End of File') {
          if (chunk === null) throw new ParseFault(i + 1);
          chunk.eof = true;
          chunk = null;
          eofClosed = true;
          i += 1;
          continue;
        }
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(chunk);
          eofClosed = false;
          i += 1;
          continue;
        }
        const c = bl[0];
        if (bl === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0 || eofClosed) throw new ParseFault(i + 1);
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push({ kind: bl === '' ? ' ' : c!, text: bl === '' ? '' : bl.slice(1), bare: bl === '' });
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      const tail = sec.chunks[sec.chunks.length - 1];
      if (tail !== undefined) while (tail.body.length > 0 && tail.body[tail.body.length - 1]!.bare) tail.body.pop();
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new ParseFault(sec.line);
    }
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    needSafe(s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new EditFault('exists', s.path);
      tree.set(s.path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new EditFault('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && s.moveTo !== s.path) needSafe(s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new EditFault('missing', s.path);
    if (s.moveTo !== undefined && s.moveTo !== s.path && tree.get(s.moveTo) !== null) throw new EditFault('exists', s.moveTo);
    const body = splitBody(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let anchorAt = -1;
        for (let tier = 0; tier <= (strict ? 0 : 2) && anchorAt < 0; tier += 1) {
          for (let k = cursor; k < body.lines.length; k += 1) {
            if (atTier(body.lines[k]!, tier) === atTier(chunk.anchor, tier)) {
              anchorAt = k;
              break;
            }
          }
        }
        if (anchorAt < 0) throw new EditFault('no-match', s.path);
        cursor = anchorAt + 1;
      }
      const old: string[] = [];
      const segs: Seg[] = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') {
          segs.push({ text: b.text, ctx: old.length });
          old.push(b.text);
        } else if (b.kind === '-') old.push(b.text);
        else if (b.kind === '+') segs.push({ text: b.text, ctx: -1 });
      }
      if (old.length === 0) {
        const at = chunk.eof ? body.lines.length : Math.min(cursor, body.lines.length);
        const add = segs.map((x) => x.text);
        body.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      let found: { tier: number; hits: number[] } | null = null;
      for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
        let hits = occurrences(body.lines, old, tier, cursor);
        if (chunk.eof) hits = hits.filter((h) => h + old.length === body.lines.length);
        if (hits.length > 0) {
          found = { tier, hits };
          break;
        }
      }
      if (found === null) throw new EditFault('no-match', s.path);
      const at = found.hits[0]!;
      const matched = body.lines.slice(at, at + old.length);
      const write = buildNew(matched, segs, found.tier, old[0]!);
      body.lines.splice(at, old.length, ...write);
      cursor = at + write.length;
    }
    const text = joinBody(body);
    if (s.moveTo !== undefined && s.moveTo !== s.path) {
      tree.set(s.moveTo, text);
      tree.set(s.path, null);
      tree.moves.push([s.path, s.moveTo] as const);
    } else {
      tree.set(s.path, text);
    }
  };
}

// ---- JSON edits (section 9) ----

/** One edit object read as an Edit, or null when it is not one (a parse fault). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const crlf = splitBody(before).brk === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const body = splitBody(before);
      if (line < 0 || line > body.lines.length) throw new EditFault('no-match', p);
      body.lines.splice(line, 0, ...add);
      tree.set(p, joinBody(body));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
  } else {
    lines.forEach((l, idx) => {
      if (isBlank(l)) return;
      let e: Edit | null = null;
      try {
        e = jsonEdit(JSON.parse(l));
      } catch {
        e = null;
      }
      if (e === null) throw new ParseFault(idx + 1);
      edits.push(e);
    });
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---- Detecting the format (section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- The command line (sections 1, 2 and 10) ----

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const file = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.state);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.state.clear();
      for (const [k, v] of snapshot) tree.state.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  // Report (section 2): one line per path whose state changed, byte order of the sort key; a move whose two
  // ends changed exactly as a move expects is one R line, sorted by the new path, in place of its A and D lines.
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      covered.add(from);
      covered.add(to);
    }
  }
  for (const p of tree.state.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byBytes(x.key, y.key));

  if (!check) {
    for (const p of tree.state.keys()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: runner.ts reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
