// IndexedDB wrapper: books (with binary blob) + state (reading position, bookmarks) + prefs.
const DB = (() => {
  const NAME = 'reader-db';
  const VERSION = 1;
  let dbp;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('prefs')) {
          db.createObjectStore('prefs', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode = 'readonly') {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function reqP(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  return {
    async addBook(book) {
      const s = await tx('books', 'readwrite');
      return reqP(s.put(book));
    },
    async getBook(id) {
      const s = await tx('books');
      return reqP(s.get(id));
    },
    async listBooks() {
      const s = await tx('books');
      return reqP(s.getAll());
    },
    async deleteBook(id) {
      const s = await tx('books', 'readwrite');
      await reqP(s.delete(id));
      const st = await tx('state', 'readwrite');
      await reqP(st.delete(id));
    },
    async getState(id) {
      const s = await tx('state');
      return (await reqP(s.get(id))) || { id, position: null, bookmarks: [], progress: 0 };
    },
    async setState(state) {
      const s = await tx('state', 'readwrite');
      return reqP(s.put(state));
    },
    async getPref(key, fallback) {
      const s = await tx('prefs');
      const v = await reqP(s.get(key));
      return v ? v.value : fallback;
    },
    async setPref(key, value) {
      const s = await tx('prefs', 'readwrite');
      return reqP(s.put({ key, value }));
    },
    async usage() {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      }
      return { usage: 0, quota: 0 };
    },
  };
})();
