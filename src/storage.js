// localStorage adapter — same get/set/list/delete shape the app used in the prototype,
// so the rest of the code is unchanged. Swap this file for an API-backed version later
// (e.g. Supabase) to sync settings/templates/plans across devices.
export const storage = {
  async get(key) {
    try { const v = localStorage.getItem(key); return v == null ? null : { key, value: v }; }
    catch (e) { return null; }
  },
  async set(key, value) {
    try { localStorage.setItem(key, value); return { key, value }; }
    catch (e) { return null; }
  },
  async delete(key) {
    try { localStorage.removeItem(key); return { key, deleted: true }; }
    catch (e) { return null; }
  },
  async list(prefix = '') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
      return { keys };
    } catch (e) { return { keys: [] }; }
  },
};
