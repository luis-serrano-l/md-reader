// The one place the front end talks to whatever reads the disk. Two implementations with the
// same methods: the local Node server (over HTTP) and the desktop app (Tauri commands).
//
//   listRoots()                -> [{ id, path, name, missing }]
//   addRoot(path)              -> root
//   removeRoot(id)
//   tree(rootId)               -> { nodes, truncated }
//   readDoc(rootId, path)      -> { path, source }
//   assetUrl(rootId, path)     -> URL of an image inside the folder
//   watch(rootId, path, fn)    -> stop function; fn runs when the note changes on disk
//   toggleFullscreen()
//   getSettings()              -> the stored fonts-and-colours object (may be empty)
//   saveSettings(settings)
// Only over HTTP:   browse(dir) -> sub-folders, for the in-page "Add folder" dialog
// Only on desktop:  pickFolder() -> path or null (native dialog), openExternal(url),
//                   exitFullscreen()

const enc = encodeURIComponent;

function httpBackend() {
  async function api(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }
  return {
    kind: 'http',
    listRoots: async () => (await api('/api/roots')).roots,
    addRoot: async (path) =>
      (
        await api('/api/roots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        })
      ).root,
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
    browse: (dir) => api(`/api/browse${dir ? `?dir=${enc(dir)}` : ''}`),
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
    openExternal: (url) => call('open_external', { url }),
    toggleFullscreen: () => call('set_fullscreen', {}),
    exitFullscreen: () => call('set_fullscreen', { on: false }),
  };
}

export const backend = window.__TAURI__ ? tauriBackend(window.__TAURI__) : httpBackend();
