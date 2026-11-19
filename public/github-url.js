// Reads a GitHub address. Pure (no DOM, no Node), used by the web version (web-backend.js);
// the desktop app has the same rules in src-tauri/src/github.rs, tested with the same lists
// of good and bad addresses (test/github.test.js). Errors carry a `status` (400 or 403).
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// A path segment that is safe as a sparse-checkout folder, as a file name and in a URL.
const SEGMENT = /^[^/\\\0-\x1f*?[\]!#]+$/;

const okSegment = (part) => part !== '.' && part !== '..' && !part.startsWith('-') && part === part.trim() && SEGMENT.test(part);

// True for the path of a folder inside a repository that may be added on its own.
export const isFolderPath = (sub) => typeof sub === 'string' && sub.length <= 1000 && sub.split('/').every(okSegment);

// True for a branch name that an address can carry (see parseGithubUrl).
export const isRef = (ref) => typeof ref === 'string' && REF.test(ref);

const fail = (status, message) => Object.assign(new Error(message), { status });
const bad = (message) => fail(400, message);

// "https://github.com/owner/repo", ".../tree/<branch>/<folder>", ".../blob/<branch>/<file>.md"
// or "owner/repo" -> { owner, repo, ref, sub, kind }. `ref` is '' for the default branch, `sub`
// is '' for the whole repository. A branch name with a "/" in it cannot be told apart from a
// folder in such a URL, so it is not supported.
export function parseGithubUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000) throw bad('Give the address of a GitHub repository, folder or file.');
  let text = input.trim();
  const ssh = /^git@github\.com:(.+)$/i.exec(text);
  if (ssh) text = ssh[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(www\.)?github\.com\//i.test(text)) {
    // The URL parser would quietly fold "." and ".." segments away; they are refused instead.
    if (/(^|\/)(\.|%2e){1,2}(?=[/?#]|$)/i.test(text)) throw bad('The path in that address cannot be used.');
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw bad('That is not a valid address.');
    }
    if (url.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(url.hostname) || url.username || url.password || url.port) {
      throw bad('Only https://github.com addresses can be added.');
    }
    text = url.pathname;
  }
  let parts;
  try {
    parts = text.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw bad('That is not a valid address.');
  }
  if (parts.length < 2) throw bad('The address must name a repository: github.com/owner/repository.');
  const [owner, rawRepo, marker, ref = '', ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') throw bad('That is not a GitHub repository name.');
  if (marker === undefined) return { owner, repo, ref: '', sub: '', kind: 'folder' };
  if (marker !== 'tree' && marker !== 'blob') throw bad('Give the address of a repository, of a folder in it, or of a .md file in it.');
  if (!REF.test(ref)) throw bad('The branch name in that address cannot be used.');
  if (!rest.every(okSegment)) {
    throw bad('The path in that address cannot be used.');
  }
  const sub = rest.join('/');
  if (marker === 'tree') return { owner, repo, ref, sub, kind: 'folder' };
  if (!sub || !/\.md$/i.test(sub)) throw fail(403, 'Only Markdown (.md) files can be added.');
  return { owner, repo, ref, sub, kind: 'file' };
}

// ---------- Submodules ----------

// The repository that the address of a submodule names, as "owner/name", or null when it is
// not one on GitHub. `parent` is the "owner/name" of the repository whose .gitmodules holds
// the address: one like "../other.git" is relative to it. Same rules as `submodule_repo` in
// github.rs.
const HOSTS = ['https://github.com/', 'https://www.github.com/', 'git@github.com:', 'ssh://git@github.com/', 'git://github.com/'];
export function submoduleRepo(parent, address) {
  if (typeof parent !== 'string' || typeof address !== 'string') return null;
  const text = address.trim();
  let parts;
  if (text.startsWith('./') || text.startsWith('../')) {
    parts = parent.split('/');
    if (parts.length !== 2) return null;
    for (const part of text.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') parts.push(part);
      else if (parts.pop() === undefined) return null;
    }
  } else {
    const host = HOSTS.find((h) => text.toLowerCase().startsWith(h));
    if (!host) return null;
    parts = text.slice(host.length).split('/').filter(Boolean);
  }
  if (parts.length !== 2) return null;
  const [owner, repo] = [parts[0], parts[1].replace(/\.git$/i, '')];
  return OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..' ? `${owner}/${repo}` : null;
}

// The value of one line of a git config file: quotes and escapes taken out, a comment cut off.
function configValue(raw) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
    } else if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '#' || ch === ';')) break;
    else out += ch;
  }
  return out.trim();
}

// The text of a .gitmodules file -> Map of submodule path -> address. Anything that is not a
// `path` or `url` line of a [submodule "..."] section is passed over.
export function parseGitmodules(text) {
  const found = new Map();
  if (typeof text !== 'string') return found;
  let entry = null;
  const entries = new Map(); // by name: a section may be written in two parts
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const name = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(trimmed)?.[1];
      entry = name === undefined ? null : entries.get(name) || {};
      if (entry) entries.set(name, entry);
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(trimmed);
    if (!entry || !pair) continue;
    const key = pair[1].toLowerCase();
    if (key === 'path' || key === 'url') entry[key] = configValue(pair[2]);
  }
  for (const { path, url } of entries.values()) if (path && url) found.set(path, url);
  return found;
}
