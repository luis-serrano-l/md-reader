// The one place the front end talks to whatever reads the disk. Two implementations with the
// same methods: the local Node server (over HTTP) and the desktop app (Tauri commands).
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
// Only over HTTP:   browse(dir, files) -> sub-folders (and .md file names), for the in-page picker
// Only on desktop:  pickFolder(), pickFile() -> path or null (native dialog), openExternal(url),
//                   exitFullscreen()

const enc = encodeURIComponent;

function httpBackend() {
  async function api(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }
  const send = (url, method, body) =>
    api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    kind: 'http',
    listRoots: async () => (await api('/api/roots')).roots,
    addRoot: async (path) => (await send('/api/roots', 'POST', { path })).root,
    addFile: async (path) => (await send('/api/roots', 'POST', { path, kind: 'file' })).root,
    addGithub: async (url) => (await send('/api/github', 'POST', { url })).root,
    updateGithub: (root) => send('/api/github/update', 'POST', { root }),
    githubToken: async () => (await api('/api/github/token')).saved,
    saveGithubToken: (token) => send('/api/github/token', 'PUT', { token }),
    clearGithubToken: () => api('/api/github/token', { method: 'DELETE' }),
    removeRoot: (id) => api(`/api/roots/${enc(id)}`, { method: 'DELETE' }),
    tree: (root) => api(`/api/tree?root=${enc(root)}`),
    readDoc: (root, path) => api(`/api/doc?root=${enc(root)}&path=${enc(path)}`),
    assetUrl: (root, path) => `/asset?root=${enc(root)}&path=${enc(path)}`,
    watch(root, path, onChange) {
      const events = new EventSource(`/api/watch?root=${enc(root)}&path=${enc(path)}`);
      events.onmessage = () => onChange();
      return () => events.close();
    },
    getSettings: async () => (await api('/api/settings')).settings,
    saveSettings: (settings) =>
      api('/api/settings', {
        method: 'PUT',
        keepalive: true, // may be sent while the page is closing
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      }),
    browse: (dir, files = false) => api(`/api/browse?files=${files ? 1 : 0}${dir ? `&dir=${enc(dir)}` : ''}`),
    async toggleFullscreen() {
      if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
      else await document.documentElement.requestFullscreen?.().catch(() => {});
    },
  };
}

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

export const backend = window.__TAURI__ ? tauriBackend(window.__TAURI__) : httpBackend();
