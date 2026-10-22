// Settings + shared app state
export const S = {
  prefs: {},
  bookmarks: [],
  recent: [],
  folderGroups: [],
  tags: [],
  tabs: {},      // paneKey -> saved tab sets
  tagsByPath: {} // path -> tagId
};

export async function loadStore() {
  const s = await window.x2.getSettings();
  Object.assign(S, {
    prefs: s?.prefs || {},
    bookmarks: s?.bookmarks || [],
    recent: s?.recent || [],
    folderGroups: s?.folderGroups || [],
    tags: s?.tags || [],
    tabs: s?.tabs || {},
    tagsByPath: s?.tagsByPath || {},
    savedLayout: s?.savedLayout,
    shortcuts: s?.shortcuts || {}
  });
}
let flushT = null;
export function persist() {
  clearTimeout(flushT);
  flushT = setTimeout(() => {
    window.x2.setSettings({
      prefs: S.prefs, bookmarks: S.bookmarks, recent: S.recent, folderGroups: S.folderGroups,
      tags: S.tags, tabs: S.tabs, tagsByPath: S.tagsByPath, savedLayout: S.savedLayout, shortcuts: S.shortcuts
    });
  }, 200);
}
export function flush() { clearTimeout(flushT); window.x2.setSettings({ prefs: S.prefs, bookmarks: S.bookmarks, recent: S.recent, folderGroups: S.folderGroups, tags: S.tags, tabs: S.tags, tagsByPath: S.tagsByPath, savedLayout: S.savedLayout, shortcuts: S.shortcuts }); window.x2.flushSettings(); }

export const defaults = () => ({
  theme: 'dark',
  accent: '',
  viewMode: 'details',          // details | list | thumbs
  columns: ['name', 'size', 'type', 'mtimeMs'],
  colWidths: null,
  showHidden: true,
  showSystem: true,
  showTree: true,
  showPreview: false,
  stackPanes: false,
  mirrorBrowse: false,
  thumbnailSize: 96,
  sortCol: 'name', sortDir: 1,
  stickySelection: false,
  checkboxSelection: false,
  confirmDelete: true,
  confirmOverwrite: true,
  personalRules: []   // color rules
});
export function pref(k, v) {
  if (v === undefined) return S.prefs[k];
  S.prefs[k] = v; persist();
  document.documentElement.dataset.theme = S.prefs.theme === 'light' ? 'light' : 'dark';
  document.documentElement.style.setProperty('--accent', S.prefs.accent || '');
  return v;
}
