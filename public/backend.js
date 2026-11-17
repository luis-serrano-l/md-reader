// The one place the front end talks to whatever holds the notes. Two implementations with the
// same methods: the desktop app (Tauri commands) and the web version (web-backend.js: GitHub
// only, no disk, so no addRoot/addFile there).
//
//   listRoots()                -> [{ id, path, name, kind: 'folder' | 'file', github, missing }]
//   addRoot(path)              -> root (a folder)
//   addFile(path)              -> root (one .md file)
//   addGithub(url)             -> root (a folder or one .md file of a GitHub repository, downloaded)
//   updateGithub(id)           -> { added, changed, removed } (.md paths)
//   githubToken()              -> true when a token is saved; it can never be read back
//   saveGithubToken(token), clearGithubToken()
//   removeRoot(id)
//   tree(rootId)               -> { nodes, truncated }
//   readDoc(rootId, path)      -> { path, source }
//   assetUrl(rootId, path)     -> URL of an image inside the folder
//   watch(rootId, path, fn)    -> stop function; fn runs when the note changes on disk
//   toggleFullscreen()
//   getSettings()              -> the stored fonts-and-colours object (may be empty)
//   saveSettings(settings)
// Only on desktop:  pickFolder(), pickFile() -> path or null (native dialog), openExternal(url),
//                   exitFullscreen()

import { webBackend } from './web-backend.js';

function tauriBackend({ core, event }) {
  async function call(command, args) {
    try {
      return await core.invoke(command, args);
    } catch (err) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Request failed');
    }
  }
  return {
    kind: 'tauri',
    listRoots: () => call('list_roots'),
    addRoot: (path) => call('add_root', { path }),
    addFile: (path) => call('add_file', { path }),
    addGithub: (url) => call('add_github', { url }),
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
    toggleFullscreen: () => call('set_fullscreen', {}),
    exitFullscreen: () => call('set_fullscreen', { on: false }),
  };
}

// Outside the desktop app the page is the web version: a static site with no server behind it.
export const backend = window.__TAURI__ ? tauriBackend(window.__TAURI__) : webBackend();
