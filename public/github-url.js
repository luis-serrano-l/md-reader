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
