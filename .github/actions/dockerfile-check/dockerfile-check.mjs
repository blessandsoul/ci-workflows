// Checks a repository's Dockerfiles WITHOUT building them: static rules plus a lockfile check. Nothing is built, started or written.
//
// Why it exists: the full image build (the `docker` job of ../../workflows/ci.yml) only runs when something an image depends on changed, so the
// mistakes a build would catch must be caught some cheaper way on every push. This finds the known-bad patterns in seconds. It does NOT see whether a
// base image exists, what `apk add` installs, Linux-only native modules, whether the container starts or whether the HEALTHCHECK works; that is
// what the real build is for.
//
// It is a Node port of the seed-plugins `docker/dockerfile_check.py` (the tool agents run locally instead of a real Docker build). Same rules, same
// messages: when a rule changes in one, change it in the other.
//
// Layer 1, static rules (the Dockerfile text, the build context and .dockerignore):
//   from-local-registry      error  FROM an image that only exists on one machine (localhost, private IP, .local)
//   from-nonpublic           warn   FROM a registry that is not a well-known public one
//   from-unpinned            warn   FROM without a tag (or :latest)
//   no-healthcheck           warn   no HEALTHCHECK and no curl/wget inside the image
//   copy-source-missing      error  COPY/ADD source not in the build context (names are case-sensitive in the image build)
//   copy-source-ignored      error  the source exists but .dockerignore keeps it out of the context
//   copy-from-unknown        error  COPY --from naming a later/current stage or a bad index (a bare unknown name only warns)
//   npm-ci-without-lockfile  error  `npm ci` but no package-lock.json in the folder the package files come from
//   arg-empty-by-default     warn   `ARG X` without a default copied by `ENV X=$X`: empty unless a build arg is passed
// Layer 2, lockfile: for each folder where the image runs `npm ci`, `npm ci --dry-run` under the npm major that the image's Node bundles, because a
//   lockfile written by a newer local npm can be rejected by the image's npm (arki-magazine, commit aefe3b0). Needs the registry; writes no
//   node_modules. A network failure is "unverified", never a failure.
//
// The build context is the Dockerfile's own folder unless its COPY sources only resolve from a parent folder (a monorepo Dockerfile built from the
// repo root, like project-fire's ai-runtime); that case is "inferred", and the image build uses the same context. Constructs the parser does not
// understand (heredoc COPY, a non-default escape directive, quoted COPY words) skip the affected rule with a note: never a false error.
//
// No dependencies: plain Node, unit-tested offline with `node --test` (dockerfile-check.test.mjs).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Never searched for Dockerfiles: build output, and folders that hold COPIES of the project (found in a real repo: outputs/<run>/client/Dockerfile
// snapshots), which would otherwise be checked and built for nothing.
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache',
  'outputs', 'output', 'docs', 'examples', 'archive', 'tmp', 'vendor', 'fixtures', '.claude', '.worktrees', 'worktrees',
]);
const MAX_DEPTH = 2; // the repo root and two folders down: Dockerfile, client/Dockerfile, services/api/Dockerfile
const PUBLIC_REGISTRIES = new Set(['docker.io', 'index.docker.io', 'ghcr.io', 'gcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'registry.k8s.io']);
const NPM_TIMEOUT_MS = 120_000;
const NPM_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);

const FLAG = /^--([A-Za-z-]+)(?:=(\S+))?\s*/;
const HEREDOC = /<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g;
const NODE_IMAGE = /^(?:docker\.io\/library\/|library\/)?node:(\d+)/;
const NPM_CI = /\bnpm\s+(?:ci|clean-install)\b/;
const NPM_ANY = /\bnpm\s/;
const SYNC_LINE = /^npm (?:error|ERR!) (?:Missing|Invalid):/m;
const SYNC_HINT = /can only install packages when your package\.json and package-lock\.json/;
const NETWORK = /\b(?:ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ERR_SOCKET_TIMEOUT)\b|fetch failed/;
// Terminal escapes and control characters (tab and newline stay): a Dockerfile's text is written by whoever controls the repository.
const UNPRINTABLE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]/g;

export const printable = (text) => String(text).replace(UNPRINTABLE, '');

function finding(level, rule, file, line, message, extra = {}) {
  return { level, rule, file, line, message, ...extra };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Python's fnmatch.fnmatchcase for one path segment: * ? [..] [!..]; an unclosed [ is a literal. */
function segmentRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '!') j += 1;
      if (pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) out += '\\[';
      else {
        let body = pattern.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        else if (body.startsWith('^')) body = `\\${body}`;
        out += `[${body}]`;
        i = j;
      }
    } else out += escapeRegex(c);
  }
  return new RegExp(`^${out}$`, 's');
}

// --------------------------------------------------------------------------- parsing

/**
 * Logical instructions of a Dockerfile (continuations joined, comments dropped) plus notes about anything not supported.
 * Each instruction: { keyword (upper case), args, line (1-based start), heredoc (RUN/COPY/ADD with an inline <<EOF body, whose body is skipped) }.
 */
export function parse(text) {
  const lines = String(text).replace(/^﻿+/, '').split(/\r\n|\r|\n/);
  const notes = [];
  for (const raw of lines) { // parser directives sit at the top, before any instruction
    const stripped = raw.trim();
    if (!stripped) continue;
    if (!stripped.startsWith('#')) break;
    const directive = stripped.match(/^#\s*escape\s*=\s*(\S)/i);
    if (directive && directive[1] !== '\\') return { instructions: [], notes: ['A non-default `# escape=` directive is not supported, so no rule could be checked for this file.'] };
  }
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('#')) {
      i += 1;
      continue;
    }
    const start = i + 1;
    const parts = [];
    for (;;) {
      const body = lines[i].trimEnd();
      if (body.endsWith('\\')) {
        parts.push(body.slice(0, -1));
        i += 1;
        while (i < n && (!lines[i].trim() || lines[i].trim().startsWith('#'))) i += 1; // comments and blanks inside a continuation are dropped
        if (i >= n) break;
        continue;
      }
      parts.push(body);
      i += 1;
      break;
    }
    const logical = parts.map((p) => p.trim()).filter(Boolean).join(' ');
    const match = logical.match(/^(\w+)\s*([\s\S]*)$/);
    if (!match) continue;
    const keyword = match[1].toUpperCase();
    const args = match[2];
    const heredoc = ['RUN', 'COPY', 'ADD'].includes(keyword) && new RegExp(HEREDOC.source).test(args);
    if (heredoc) { // skip the body up to each terminator line
      for (const [, name] of args.matchAll(HEREDOC)) {
        while (i < n && lines[i].trim() !== name) i += 1;
        i += 1;
      }
    }
    out.push({ keyword, args, line: start, heredoc });
  }
  return { instructions: out, notes };
}

/** [image, stage name or null] of a FROM instruction, or null when it cannot be read. */
export function splitFrom(args) {
  let rest = args.trim();
  while (rest.startsWith('--')) {
    const flag = rest.match(FLAG);
    if (!flag) return null;
    rest = rest.slice(flag[0].length);
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  return [tokens[0], tokens.length >= 3 && tokens[1].toLowerCase() === 'as' ? tokens[2] : null];
}

/** { flags, words } of a COPY/ADD, or null when the form is not understood (quoted words, malformed JSON, fewer than two words). */
export function splitCopy(args) {
  const flags = {};
  let rest = args.trim();
  while (rest.startsWith('--')) {
    const flag = rest.match(FLAG);
    if (!flag) return null;
    flags[flag[1].toLowerCase()] = flag[2] || '';
    rest = rest.slice(flag[0].length);
  }
  let words;
  if (rest.startsWith('[')) {
    try {
      words = JSON.parse(rest);
    } catch {
      return null;
    }
    if (!Array.isArray(words) || !words.every((w) => typeof w === 'string')) return null;
  } else {
    words = rest.split(/\s+/).filter(Boolean);
    if (words.some((w) => w.includes('"') || w.includes("'"))) return null;
  }
  return words.length >= 2 ? { flags, words } : null;
}

/** [name, hasDefault] for every name an ARG instruction declares. */
export function argNames(args) {
  const declared = [];
  for (const token of args.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) declared.push([name, eq !== -1]);
  }
  return declared;
}

/** [key, value] pairs of an ENV instruction, both the `K=V K2=V2` and the legacy `K V` forms (a quoted value with spaces yields its first word). */
export function envPairs(args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  if (!tokens[0].includes('=')) {
    const legacy = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
    return legacy ? [[legacy[1], legacy[2].trim()]] : [];
  }
  return tokens.filter((t) => t.includes('=')).map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]).filter(([k]) => k);
}

// --------------------------------------------------------------------------- the build context

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

/** Existence with EXACT letter case at every segment: the image build runs on Linux, while Windows and macOS would say yes to `Package.json`. */
export function exactExists(context, rel) {
  let current = context;
  for (const segment of rel.split('/').filter((s) => s !== '' && s !== '.')) {
    const names = listDir(current);
    if (!names || !names.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

/** The spelling that actually exists when `rel` differs from it only by letter case. */
function caseVariant(context, rel) {
  let current = context;
  const actual = [];
  for (const segment of rel.split('/').filter((s) => s !== '' && s !== '.')) {
    const names = listDir(current);
    const hit = names && names.find((name) => name.toLowerCase() === segment.toLowerCase());
    if (!hit) return null;
    actual.push(hit);
    current = path.join(current, hit);
  }
  return actual.join('/');
}

function isRealDir(p) {
  try {
    return fs.lstatSync(p).isDirectory(); // lstat: a symlinked folder is not followed, like the builder
  } catch {
    return false;
  }
}

/** Paths (relative, `/`-separated) matching a COPY source pattern, case-sensitively. Supports * ? [..] and ** like the builder. */
export function expand(context, pattern) {
  const found = [];
  const entries = (base) => (listDir(base) || []).sort();
  const walk = (base, rel, rest) => {
    if (!rest.length) {
      found.push(rel.join('/'));
      return;
    }
    const [segment, ...tail] = rest;
    if (segment === '**') {
      walk(base, rel, tail);
      for (const name of entries(base)) if (isRealDir(path.join(base, name))) walk(path.join(base, name), [...rel, name], rest);
    } else if (!/[*?[]/.test(segment)) {
      if (entries(base).includes(segment)) walk(path.join(base, segment), [...rel, segment], tail);
    } else {
      const re = segmentRegex(segment);
      for (const name of entries(base)) if (re.test(name)) walk(path.join(base, name), [...rel, name], tail);
    }
  };
  walk(context, [], pattern.split('/').filter((s) => s !== '' && s !== '.'));
  return found;
}

/**
 * .dockerignore semantics: patterns are relative to the context root, `*` does not cross `/`, `**` does, a match on a parent folder ignores
 * everything below it, the LAST matching pattern wins and `!` re-includes. Patterns using [..] classes, escapes or {..} are not understood; if one of
 * those is a negation the answer is unknown (`sure` is false) and the rule stays silent rather than guess.
 */
export class Ignore {
  constructor(lines) {
    this.rules = [];
    this.unsupported = 0;
    this.sure = true;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negated = line.startsWith('!');
      let pattern = (negated ? line.slice(1).trim() : line).replace(/^\/+/, '').replace(/\/+$/, '');
      if (pattern.startsWith('./')) pattern = pattern.slice(2);
      if (!pattern) continue;
      const regex = Ignore.compile(pattern);
      if (!regex) {
        this.unsupported += 1;
        if (negated) this.sure = false;
        continue;
      }
      this.rules.push([line, negated, regex]);
    }
  }

  /** A context-relative glob as a regex (`*` stays inside one folder, `**` crosses folders), or null for [..], escapes and {..}. */
  static compile(pattern) {
    if (/[[\\{]/.test(pattern)) return null;
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          while (pattern[i + 1] === '*') i += 1;
          if (i + 1 === pattern.length) out += '.*';
          else if (pattern[i + 1] === '/') {
            i += 1;
            out += '(.*/)?';
          } else out += '.*';
        } else out += '[^/]*';
      } else if (c === '?') out += '[^/]';
      else out += escapeRegex(c);
    }
    return new RegExp(`^${out}$`);
  }

  /** The pattern that excludes `rel` from the context, or null when it is included. */
  ignoredBy(rel) {
    const parts = rel.split('/');
    const candidates = parts.map((_, k) => parts.slice(0, k + 1).join('/')); // the path itself and every parent folder
    let verdict = null;
    for (const [raw, negated, regex] of this.rules) {
      if (candidates.some((c) => regex.test(c))) verdict = negated ? null : raw;
    }
    return verdict;
  }
}

/** The ignore file the builder uses: `<Dockerfile name>.dockerignore` beside the Dockerfile wins, otherwise `.dockerignore` at the context root. */
function loadIgnore(context, dockerfile) {
  for (const p of [path.join(path.dirname(dockerfile), `${path.basename(dockerfile)}.dockerignore`), path.join(context, '.dockerignore')]) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return new Ignore(fs.readFileSync(p, 'utf8').split(/\r\n|\r|\n/));
  }
  return null;
}

/** [instruction, sources] of every COPY/ADD from the build context that can be read (not --from, not heredoc, not an unknown form). */
function plainCopies(instructions) {
  const out = [];
  for (const ins of instructions) {
    if ((ins.keyword !== 'COPY' && ins.keyword !== 'ADD') || ins.heredoc) continue;
    const parsed = splitCopy(ins.args);
    if (parsed && !('from' in parsed.flags)) out.push([ins, parsed.words.slice(0, -1)]);
  }
  return out;
}

/** A COPY source as a context-relative path; null for URLs, variables and the whole context. */
function contextPath(source) {
  if (source.includes('$') || /^(https?:\/\/|git@)/.test(source)) return null;
  let rel = source.replace(/^\/+/, '');
  if (rel.startsWith('./')) rel = rel.slice(2);
  rel = rel.replace(/\/+$/, '');
  return rel === '' || rel === '.' ? null : rel;
}

/**
 * The build context: the Dockerfile's own folder, unless its COPY sources only resolve from a parent folder.
 *
 * Coolify and a plain `docker build` use the Dockerfile's folder by default, but a monorepo Dockerfile (`COPY ai-runtime/pyproject.toml ...`) is
 * built from a parent folder, usually the repo root. Judging (or building) such a file against its own folder would report every COPY as missing.
 * Wildcard sources are optional by nature and take no part in the decision; if no folder satisfies every source, the own folder is used and the
 * errors are reported against it.
 */
function pickContext(root, dockerfile, instructions) {
  const wanted = plainCopies(instructions)
    .flatMap(([, sources]) => sources)
    .map(contextPath)
    .filter((rel) => rel && !rel.startsWith('..') && !/[*?[]/.test(rel));
  const own = path.dirname(dockerfile);
  const chain = [own];
  let current = own;
  while (current !== root && isInside(root, current)) {
    current = path.dirname(current);
    chain.push(current);
  }
  return chain.find((candidate) => wanted.every((rel) => exactExists(candidate, rel))) || own;
}

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Folders (relative to the build context) holding the package files this Dockerfile copies, i.e. where `npm ci` really runs. '.' when it copies
 * them from the context root or not explicitly. In a monorepo-root context this is the app's own folder (`aichats-agent`).
 */
function npmDirs(instructions) {
  const folders = [];
  for (const [, sources] of plainCopies(instructions)) {
    for (const source of sources) {
      const rel = contextPath(source);
      const base = rel ? path.posix.basename(rel) : '';
      if (rel && !rel.startsWith('..') && (NPM_FILES.has(base) || segmentRegex('package*.json').test(base) || base.startsWith('package-lock.json'))) {
        const folder = path.posix.dirname(rel);
        if (!folders.includes(folder)) folders.push(folder);
      }
    }
  }
  return folders.length ? folders : ['.'];
}

const toPosix = (p) => p.split(path.sep).join('/');
// '.' for the root itself. Compared through path.relative, never as strings: `C:/repo` and `C:\repo\` are the same folder, and an empty context
// handed to the image build would make it build from the wrong place.
const relFromRoot = (root, p) => toPosix(path.relative(root, p)) || '.';

// --------------------------------------------------------------------------- layer 1: static rules

function registryFindings(file, line, image) {
  const first = image.split('/')[0];
  if (!image.includes('/') || !(first.includes('.') || first.includes(':') || first === 'localhost')) return [];
  const host = first.split(':')[0].toLowerCase();
  const local = ['localhost', '127.0.0.1', '0.0.0.0'].includes(host) || host.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (local) return [finding('error', 'from-local-registry', file, line, `FROM ${image} uses a registry that only exists on one machine. The build fails everywhere else.`)];
  if (!PUBLIC_REGISTRIES.has(host)) return [finding('warn', 'from-nonpublic', file, line, `FROM ${image} uses a non-public registry (${host}); make sure CI and the servers can reach it.`)];
  return [];
}

function copyFromFindings(file, line, source, stage, stageNames) {
  if (source.includes('$')) return [];
  const lowered = source.toLowerCase();
  if (stageNames.has(lowered)) {
    if (stageNames.get(lowered) < stage) return [];
    return [finding('error', 'copy-from-unknown', file, line, `COPY --from=${source} names a stage that is not defined before this one (the current or a later stage).`)];
  }
  if (/^\d+$/.test(source)) {
    if (Number(source) < stage) return [];
    return [finding('error', 'copy-from-unknown', file, line, `COPY --from=${source} is not an earlier stage index (this is stage ${stage}).`)];
  }
  if (/[/:@]/.test(source)) return []; // an image reference
  return [finding('warn', 'copy-from-unknown', file, line, `COPY --from=${source} is not an earlier stage; if it is a typo the build pulls an image of that name instead.`)];
}

function copySourceFindings(context, contextRel, file, ins, sources, ignore) {
  const out = [];
  let matchedAny = false;
  const wildcardMisses = [];
  for (const source of sources) {
    if (source.includes('$') || /^(https?:\/\/|git@)/.test(source)) {
      matchedAny = true;
      continue;
    }
    let rel = source.replace(/^\/+/, '');
    if (rel.startsWith('./')) rel = rel.slice(2);
    if (rel === '' || rel === '.' || rel === './' || rel.replace(/\/+$/, '') === '.') {
      matchedAny = true;
      continue; // the whole context
    }
    if (rel.startsWith('../') || rel === '..') {
      out.push(finding('error', 'copy-source-missing', file, ins.line, `${ins.keyword} source "${source}" is outside the build context (${contextRel}).`));
      continue;
    }
    rel = rel.replace(/\/+$/, '');
    if (/[*?[]/.test(rel)) {
      const hits = expand(context, rel);
      if (!hits.length) {
        wildcardMisses.push(source);
        continue;
      }
      matchedAny = true;
      const excluded = ignore && ignore.sure ? hits.map((hit) => [hit, ignore.ignoredBy(hit)]) : [];
      if (excluded.length && excluded.every(([, by]) => by)) {
        out.push(finding('error', 'copy-source-ignored', file, ins.line, `${ins.keyword} source "${source}" matches only files that .dockerignore excludes (pattern "${excluded[0][1]}").`));
      }
      continue;
    }
    if (!exactExists(context, rel)) {
      const variant = caseVariant(context, rel);
      const hint = variant ? ` It exists as "${variant}": the name differs only by letter case, which fails in the Linux image build.` : '';
      out.push(finding('error', 'copy-source-missing', file, ins.line, `${ins.keyword} source "${source}" does not exist in the build context (${contextRel}).${hint}`));
      continue;
    }
    matchedAny = true;
    const by = ignore && ignore.sure ? ignore.ignoredBy(rel) : null;
    if (by) out.push(finding('error', 'copy-source-ignored', file, ins.line, `${ins.keyword} source "${source}" is excluded by .dockerignore (pattern "${by}"), so it is not in the build context.`));
  }
  if (wildcardMisses.length && !matchedAny) {
    out.push(finding('warn', 'copy-source-missing', file, ins.line, `${ins.keyword} pattern(s) ${wildcardMisses.join(', ')} match nothing in the build context (${contextRel}).`));
  }
  return out;
}

/**
 * Static findings for one Dockerfile, plus what the lockfile layer and the CI planner need:
 *   context / contextInferred  the folder the image is built from (see pickContext)
 *   sources                    what the Dockerfile copies from the context by name ({ path, glob }), and copiesWholeContext for `COPY . .`
 *   usesNpm / npmFolders       whether a RUN uses npm, and the repo-relative folders whose package files it copies (where `npm ci` runs)
 *   lockfileFolders            the npmFolders that have a lockfile and run `npm ci`: what layer 2 checks
 */
export function analyse(rootPath, dockerfilePath, buildArgs = new Set()) {
  const root = path.resolve(rootPath);
  const dockerfile = path.resolve(dockerfilePath);
  const file = toPosix(path.relative(root, dockerfile));
  const text = fs.readFileSync(dockerfile, 'utf8');
  const { instructions, notes } = parse(text);
  const context = pickContext(root, dockerfile, instructions);
  const contextRel = relFromRoot(root, context);
  const contextInferred = context !== path.dirname(dockerfile);
  if (contextInferred) notes.push(`${file}: build context taken to be ${contextRel} (its COPY sources resolve there, not in the Dockerfile folder).`);
  const findings = [];
  const froms = instructions.filter((ins) => ins.keyword === 'FROM').map((ins) => [ins, splitFrom(ins.args)]);
  const stageNames = new Map();
  froms.forEach(([, parsed], index) => {
    if (parsed && parsed[1]) stageNames.set(parsed[1].toLowerCase(), index); // a reused name means its last stage, as in the Python twin
  });
  let nodeMajor = null;
  const hasHealthcheck = instructions.some((ins) => ins.keyword === 'HEALTHCHECK');
  const hasHttpTool = instructions.some((ins) => /\b(curl|wget)\b/.test(ins.args)); // installed, or used by a health check command
  const runsNpmCi = instructions.some((ins) => ins.keyword === 'RUN' && NPM_CI.test(ins.args));
  const usesNpm = instructions.some((ins) => ins.keyword === 'RUN' && NPM_ANY.test(`${ins.args} `));

  const seenStageNames = new Set();
  for (const [ins, parsed] of froms) {
    if (!parsed) continue;
    const [image, name] = parsed;
    const lowered = image.toLowerCase();
    if (!seenStageNames.has(lowered) && !image.includes('$') && lowered !== 'scratch') {
      findings.push(...registryFindings(file, ins.line, image));
      const tag = image.includes('@') ? 'pinned' : (image.split('/').pop().split(':')[1] ?? '');
      if (!tag || tag === 'latest') findings.push(finding('warn', 'from-unpinned', file, ins.line, `FROM ${image} is not pinned to a version, builds can change without a commit.`));
      const node = lowered.match(NODE_IMAGE);
      if (nodeMajor === null && node) nodeMajor = Number(node[1]);
    }
    if (name) seenStageNames.add(name.toLowerCase());
  }
  if (!hasHealthcheck && !hasHttpTool) {
    findings.push(finding('warn', 'no-healthcheck', file, null, "no HEALTHCHECK and no curl/wget; Coolify's HTTP health check needs one of them inside the image."));
  }

  const ignore = loadIgnore(context, dockerfile);
  if (ignore && ignore.unsupported) {
    notes.push(`${ignore.unsupported} .dockerignore pattern(s) use [..], escapes or {..} and were not understood`
      + (ignore.sure ? '; copy-source-ignored may miss problems.' : '; one is a "!" re-include, so copy-source-ignored was skipped.'));
  }
  let stage = -1;
  let stageArgs = new Map(); // ARGs declared in the current stage -> has a default
  const emptyArgs = []; // [ARG name, line of the ENV that copies it]: reported once per Dockerfile
  for (const ins of instructions) {
    if (ins.keyword === 'FROM') {
      stage += 1;
      stageArgs = new Map();
    } else if (ins.keyword === 'ARG' && stage >= 0) {
      for (const [arg, hasDefault] of argNames(ins.args)) stageArgs.set(arg, hasDefault);
    } else if (ins.keyword === 'ENV' && stage >= 0) {
      for (const [, value] of envPairs(ins.args)) {
        const ref = value.trim().match(/^"?\$(?:\{(\w+)\}|(\w+))"?$/);
        const name = ref ? ref[1] || ref[2] : null;
        if (name && stageArgs.get(name) === false && !buildArgs.has(name) && !emptyArgs.some(([n]) => n === name)) emptyArgs.push([name, ins.line]);
      }
    } else if (ins.keyword === 'COPY' || ins.keyword === 'ADD') {
      if (ins.heredoc) {
        notes.push(`line ${ins.line}: a ${ins.keyword} with an inline heredoc was not checked.`);
        continue;
      }
      const parsed = splitCopy(ins.args);
      if (!parsed) {
        notes.push(`line ${ins.line}: this ${ins.keyword} form is not understood, so it was not checked.`);
        continue;
      }
      if ('from' in parsed.flags) findings.push(...copyFromFindings(file, ins.line, parsed.flags.from, stage, stageNames));
      else findings.push(...copySourceFindings(context, contextRel, file, ins, parsed.words.slice(0, -1), ignore));
    }
  }

  if (emptyArgs.length) {
    const names = emptyArgs.map(([n]) => n);
    const one = names.length === 1;
    findings.push(finding('warn', 'arg-empty-by-default', file, emptyArgs[0][1],
      `ARG ${names.join(', ')} ${one ? 'has' : 'have'} no default and ${one ? 'is' : 'are'} copied into ENV: without --build-arg `
      + `${one ? 'it is an empty string' : 'each is an empty string'} at build time (build-time value(s) the real deploy supplies). `
      + `A build that validates ${one ? 'it' : 'one'} fails. Pass ${one ? 'it' : 'them'} with --build-arg (CI: docker-build-args) or give the ARG a default.`,
      { names }));
  }

  // `npm ci` runs where the package files were copied, which in a monorepo-root context is the app's own folder, not the context itself.
  const npmFolders = usesNpm ? npmDirs(instructions).map((folder) => relFromRoot(root, folder === '.' ? context : path.join(context, folder))) : [];
  const lockfileFolders = [];
  if (runsNpmCi) {
    for (const rel of npmFolders) {
      const base = rel === '.' ? root : path.join(root, rel);
      if (!exactExists(base, 'package.json')) continue; // copy-source-missing reports a package.json that is copied explicitly and absent
      if (['package-lock.json', 'npm-shrinkwrap.json'].some((name) => exactExists(base, name))) lockfileFolders.push(rel);
      else findings.push(finding('error', 'npm-ci-without-lockfile', file, null, `RUN npm ci needs package-lock.json (or npm-shrinkwrap.json) in ${rel}, none was found.`));
    }
  }

  const sources = [];
  let copiesWholeContext = false;
  for (const [, list] of plainCopies(instructions)) {
    for (const source of list) {
      const rel = contextPath(source);
      if (rel === null) copiesWholeContext ||= !source.includes('$') && !/^(https?:\/\/|git@)/.test(source);
      else if (!rel.startsWith('..')) sources.push({ path: rel, glob: /[*?[]/.test(rel) });
    }
  }
  const port = (text.match(/^\s*EXPOSE\s+(\d+)/im) || [])[1] || '';

  return { file, context: contextRel, contextInferred, findings, notes, nodeMajor, runsNpmCi, usesNpm, npmFolders, lockfileFolders, sources, copiesWholeContext, port, text };
}

// --------------------------------------------------------------------------- layer 2: lockfile

/** The npm major that a node:NN image bundles (Node 18-22 ship npm 10, Node 24+ ships npm 11), or null when unknown. */
export function npmMajorFor(nodeMajor) {
  if (nodeMajor === null || nodeMajor === undefined || nodeMajor < 18) return null;
  return nodeMajor >= 24 ? 11 : 10;
}

/** Turn the result of `npm ci --dry-run` into { status: ok | error | unverified | warn, message }. */
export function classifyNpm(code, output, npmMajor) {
  const text = printable(output);
  if (code === 0) return { status: 'ok', message: `package-lock.json is accepted by npm ${npmMajor}.` };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (SYNC_LINE.test(text) || SYNC_HINT.test(text)) {
    const detail = lines.filter((l) => /^npm (?:error|ERR!) (?:Missing|Invalid):/.test(l)).slice(0, 6);
    return {
      status: 'error',
      message: `package-lock.json is out of sync with package.json under npm ${npmMajor}, so \`npm ci\` in the image fails: `
        + (detail.map((d) => d.replace(/^npm (?:error|ERR!) /, '')).join('; ') || 'see `npm ci` output')
        + `. Regenerate the lockfile with npm ${npmMajor} (npx npm@${npmMajor} install).`,
    };
  }
  if (NETWORK.test(text)) return { status: 'unverified', message: 'could not reach the npm registry, so the lockfile was not verified.' };
  const first = lines.find((l) => l.startsWith('npm error') || l.startsWith('npm ERR!')) || lines[lines.length - 1] || 'no output';
  return { status: 'warn', message: `\`npm ci --dry-run\` under npm ${npmMajor} failed in a way this check does not recognise: ${first.slice(0, 200)}` };
}

/**
 * How to start npx without a shell. Node refuses to spawn a .cmd (npx on Windows) without one, and through a shell an argument such as a folder named
 * `a&ver` (it comes from the repository's own COPY paths) would become a second command. So npm's own npx-cli.js is run with this Node, which takes
 * every argument verbatim; on Linux runners `npx` on PATH is the fallback.
 */
function npxCommand() {
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')]) {
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  }
  return process.platform === 'win32' ? null : ['npx', []];
}

function defaultRun(command, args, options) {
  const done = spawnSync(command, args, { ...options, encoding: 'utf8', windowsHide: true });
  if (done.error) return { error: done.error.code === 'ETIMEDOUT' ? 'npx did not answer in time.' : `npx could not be started (${done.error.code || done.error.message}).` };
  return { code: done.status ?? 1, output: `${done.stdout || ''}\n${done.stderr || ''}` };
}

/**
 * `npm ci --dry-run` for one app folder under the image's npm major.
 *
 * npx runs from an EMPTY scratch folder and the project is passed with --prefix. Run from inside the project, npx would resolve `npm` (the package
 * it then executes) through the project's own .npmrc and node_modules, so a repository could point its registry at a server of its own and get code
 * run (confirmed in the Python twin). The project's .npmrc still applies to the dependency lookup itself, which private registries need.
 */
export function lockfileCheck(root, folderRel, npmMajor, run = defaultRun) {
  const folder = folderRel === '.' ? root : path.join(root, folderRel);
  const npx = npxCommand();
  if (!npx) return { folder: folderRel, npm: npmMajor, status: 'unverified', message: 'npx was not found next to this Node, so the lockfile was not verified.' };
  const env = { ...process.env, CI: 'true', NO_COLOR: '1', npm_config_update_notifier: 'false' };
  const args = [...npx[1], '--yes', '--no-audit', '--no-fund', `npm@${npmMajor}`, 'ci', '--prefix', folder, '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerfile-check-'));
  try {
    const result = run(npx[0], args, { cwd: scratch, env, timeout: NPM_TIMEOUT_MS });
    if (result.error) return { folder: folderRel, npm: npmMajor, status: 'unverified', message: `${result.error} The lockfile was not verified.` };
    return { folder: folderRel, npm: npmMajor, ...classifyNpm(result.code, result.output, npmMajor) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------- orchestration

/** Absolute paths of the Dockerfiles in the repo root or up to two folders down (`Dockerfile`, `Dockerfile.prod`; not `Dockerfile.dockerignore`). */
export function findDockerfiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && depth < MAX_DEPTH) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && /^Dockerfile(\..+)?$/.test(e.name) && !e.name.endsWith('.dockerignore')) {
        found.push(path.join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return found;
}

/** The whole check. `buildArgs` are the KEY=VALUE lines the caller passes to the build (only the names matter). */
export function check(rootPath, { buildArgs = [], lockfile = true, npmVersion = null, run = defaultRun } = {}) {
  const root = path.resolve(rootPath);
  const names = new Set(buildArgs.map((a) => a.split('=')[0].trim()).filter(Boolean));
  const dockerfiles = findDockerfiles(root).map((d) => analyse(root, d, names));
  const lockfiles = [];
  const notes = dockerfiles.length ? [] : ['No Dockerfile found in the folder or up to two levels below it.'];
  if (lockfile) {
    const done = new Set();
    for (const entry of dockerfiles) {
      for (const folder of entry.lockfileFolders) { // folders with package.json and a lockfile; a missing lockfile is a static finding
        const major = npmVersion || npmMajorFor(entry.nodeMajor);
        if (major === null) {
          lockfiles.push({ folder, npm: null, status: 'skipped', message: `cannot tell which npm ${entry.file}'s base image uses (not a node:NN image).` });
          continue;
        }
        if (done.has(`${folder}\n${major}`)) continue;
        done.add(`${folder}\n${major}`);
        lockfiles.push(lockfileCheck(root, folder, major, run));
      }
    }
  }
  const flat = dockerfiles.flatMap((e) => e.findings);
  for (const r of lockfiles) {
    if (r.status === 'error' || r.status === 'warn') flat.push(finding(r.status, 'lockfile', `${r.folder}/package-lock.json`.replace(/^\.\//, ''), null, r.message));
  }
  return {
    root,
    dockerfiles: dockerfiles.map(({ text, ...rest }) => rest),
    lockfile: lockfiles,
    findings: flat,
    notes: [...notes, ...dockerfiles.flatMap((e) => e.notes)],
    errors: flat.filter((f) => f.level === 'error').length,
    warnings: flat.filter((f) => f.level === 'warn').length,
  };
}

export function asText(report) {
  const lines = [report.root];
  for (const entry of report.dockerfiles) {
    lines.push(`${entry.file} (context ${entry.context}${entry.contextInferred ? ', inferred' : ''}): ${entry.findings.length ? `${entry.findings.length} finding(s)` : 'no findings'}`);
    for (const f of entry.findings) lines.push(`  ${f.level.toUpperCase().padEnd(5)} ${(f.line ? `line ${f.line}` : 'file').padEnd(8)} [${f.rule}] ${f.message}`);
  }
  for (const r of report.lockfile) {
    const label = { ok: 'ok', error: 'ERROR', warn: 'WARN', unverified: 'unverified', skipped: 'skipped' }[r.status];
    lines.push(`lockfile ${r.folder} (npm ${r.npm}): ${label}: ${r.message}`);
  }
  for (const n of report.notes) lines.push(`note: ${n}`);
  lines.push(`${report.errors} error(s), ${report.warnings} warning(s). Nothing was built, started or written.`);
  return printable(lines.join('\n'));
}

/** A GitHub workflow command, escaped so text from the repository can neither break the annotation nor start another command. */
function annotation(f) {
  const data = (s) => printable(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const where = f.file ? ` file=${prop(f.file)}${f.line ? `,line=${f.line}` : ''},title=${prop(f.rule)}` : '';
  return `::${f.level === 'error' ? 'error' : 'warning'}${where}::${data(f.message)}`;
}

/** Markdown for the run's summary page. */
export function summaryOf(report) {
  const out = ['### Docker check (no build)', ''];
  for (const e of report.dockerfiles) out.push(`- \`${e.file}\`, context \`${e.context}\`${e.contextInferred ? ' (inferred)' : ''}: ${e.findings.length ? `${e.findings.length} finding(s)` : 'clean'}`);
  for (const r of report.lockfile) out.push(`- lockfile \`${r.folder}\` under npm ${r.npm}: ${r.status}`);
  if (report.findings.length) out.push('', ...report.findings.map((f) => `- ${f.level === 'error' ? '❌' : '⚠️'} \`${f.file}\`${f.line ? `:${f.line}` : ''} [${f.rule}] ${printable(f.message)}`));
  out.push('', `${report.errors} error(s), ${report.warnings} warning(s).`);
  return `${out.join('\n')}\n`;
}

function main(argv) {
  const opts = { root: '.', buildArgs: [], lockfile: true, npmVersion: null, json: false, github: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo-root') opts.root = argv[(i += 1)];
    else if (a === '--build-arg') opts.buildArgs.push(argv[(i += 1)]);
    else if (a === '--no-lockfile') opts.lockfile = false;
    else if (a === '--npm-version') opts.npmVersion = Number(argv[(i += 1)]);
    else if (a === '--json') opts.json = true;
    else if (a === '--github') opts.github = true;
    else {
      console.error(`unknown option ${a}`);
      return 2;
    }
  }
  // In CI the caller's `docker-build-args` input arrives here, one KEY=VALUE per line; only the names are used and nothing is printed.
  if (process.env.CI_DOCKER_BUILD_ARGS) opts.buildArgs.push(...process.env.CI_DOCKER_BUILD_ARGS.split('\n').map((l) => l.trim()).filter(Boolean));
  const report = check(opts.root, opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(asText(report));
  if (opts.github) {
    for (const f of report.findings) console.log(annotation(f));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryOf(report));
  }
  return report.errors ? 1 : 0;
}

// Run only when executed directly (the action, or locally), not when imported by detect.mjs or the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
