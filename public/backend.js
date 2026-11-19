// The one place the front end talks to whatever holds the notes. GitHub sources are read by
// web-backend.js in both versions. The web version has nothing else (no disk, so no
// addRoot/addFile there); the desktop app adds local folders and files through Tauri commands,
// and keeps the list of GitHub sources and the token in its own files.
//
//   listRoots()                -> [{ id, path, name, kind: 'folder' | 'file', github, missing }]
//   addRoot(path)              -> root (a folder)
//   addFile(path)              -> root (one .md file)
//   githubFolders(url)         -> { direct, repo, ref, total, folders: [{ path, count }], truncated, skipped }:
//                                 the folders of a repository that hold notes, those of its
//                                 submodules included; direct = the address already names one
//                                 folder or file; skipped = submodules that could not be read
//   addGithub(url, sub?)       -> root (a folder or one .md file of a GitHub repository),
//                                 with `skipped` as above; `sub` narrows a whole repository to
//                                 one folder from githubFolders()
//   updateGithub(id)           -> { added, changed, removed, skipped } (.md paths; skipped as above)
//   githubToken()              -> true when a token is saved; it can never be read back
//   saveGithubToken(token), clearGithubToken()
//   removeRoot(id)
//   tree(rootId)               -> { nodes, truncated }
//   readDoc(rootId, path)      -> { path, source }
//   assetUrl(rootId, path)     -> URL of an image inside the folder
//   fillImages(container, note)-> promise; gives the images of a private repository their
//                                 addresses where no service worker does (`note` names the open note)
//   watch(rootId, path, fn)    -> stop function; fn runs when the note changes on disk
//   setFullscreen(on)          -> whether the window (or the browser) is in full screen afterwards
//   getSettings()              -> the stored fonts-and-colours object (may be empty)
//   saveSettings(settings)
// Only on desktop:  pickFolder(), pickFile() -> path or null (native dialog), openExternal(url)

import { webBackend } from './web-backend.js';

// A Tauri command, with its failure as an Error.
const caller = (core) => async (command, args) => {
  try {
    return await core.invoke(command, args);
  } catch (err) {
    throw new Error(typeof err === 'string' ? err : err?.message || 'Request failed');
  }
};

function tauriBackend({ core, event }) {
  const call = caller(core);
  return {
    kind: 'tauri',
    listRoots: () => call('list_roots'),
    addRoot: (path) => call('add_root', { path }),
    addFile: (path) => call('add_file', { path }),
    addGithub: (url, sub = '') => call('add_github', { url, sub }),
    githubFolders: (url) => call('github_folders', { url }),
    updateGithub: (root) => call('update_github', { root }),
    githubToken: () => call('github_token_status'),
    saveGithubToken: (token) => call('set_github_token', { token }),
    clearGithubToken: () => call('clear_github_token'),
    removeRoot: (id) => call('remove_root', { id }),
    tree: (root) => call('tree', { root }),
    readDoc: (root, path) => call('read_doc', { root, path }),
    // Served by the app's own "mdr" protocol, which applies the same folder guard.
    assetUrl: (root, path) => core.convertFileSrc(`${root}/${path}`, 'mdr'),
    watch(root, path, onChange) {
      let timer = null;
      const unlisten = event.listen('doc-changed', ({ payload }) => {
        if (payload.root !== root || payload.path !== path) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, 150);
      });
      call('watch_doc', { root, path }).catch(() => {});
      return () => {
        clearTimeout(timer);
        unlisten.then((stop) => stop());
        call('unwatch_doc', { root, path }).catch(() => {});
      };
    },
    getSettings: () => call('get_settings'),
    saveSettings: (settings) => call('save_settings', { settings }),
    pickFolder: () => call('pick_folder'),
    pickFile: () => call('pick_file'),
    openExternal: (url) => call('open_external', { url }),
    setFullscreen: (on) => call('set_fullscreen', { on: !!on }),
  };
}

// The desktop app: local sources from Tauri, GitHub sources from web-backend.js, which is given
// the desktop's places for its list (the config file) and for the token (a file beside it).
function desktopBackend(tauri) {
  const local = tauriBackend(tauri);
  const call = caller(tauri.core);
  let sources = [];
  const github = webBackend({
    hosted: false,
    store: {
      ready: call('get_github_sources').then((list) => void (sources = list)),
      get: (key, fallback) => (key === 'sources' ? sources : fallback),
      set: (key, value) => {
        if (key !== 'sources') return undefined;
        sources = value;
        return call('save_github_sources', { sources });
      },
    },
    tokens: {
      read: () => call('github_token'),
      save: (token) => call('set_github_token', { token }),
      clear: () => call('clear_github_token'),
    },
  });
  // A source belongs to whoever lists it; the two kinds of id never look alike.
  const of = (id) => (github.has(id) ? github : local);
  return {
    ...local,
    listRoots: async () => [...(await local.listRoots()), ...(await github.listRoots())],
    addGithub: github.addGithub,
    githubFolders: github.githubFolders,
    updateGithub: github.updateGithub,
    githubToken: github.githubToken,
    saveGithubToken: github.saveGithubToken,
    clearGithubToken: github.clearGithubToken,
    fillImages: github.fillImages,
    removeRoot: (id) => of(id).removeRoot(id),
    tree: (id) => of(id).tree(id),
    readDoc: (id, path) => of(id).readDoc(id, path),
    assetUrl: (id, path) => of(id).assetUrl(id, path),
    watch: (id, path, onChange) => of(id).watch(id, path, onChange),
  };
}

// Outside the desktop app the page is the web version: a static site with no server behind it.
export const backend = window.__TAURI__ ? desktopBackend(window.__TAURI__) : webBackend();
