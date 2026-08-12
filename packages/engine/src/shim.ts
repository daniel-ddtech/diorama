export function makeTabsQueryShim(stageTabId: number): string {
  return `(() => {
    if (!globalThis.chrome?.tabs?.query) return;
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, cb) => {
      const wantsActive = q && q.active && (q.currentWindow || q.lastFocusedWindow);
      const run = wantsActive
        ? orig({}).then(ts => { const t = ts.find(x => x.id === ${stageTabId}); return t ? [t] : []; })
        : orig(q);
      if (typeof cb === "function") { run.then(cb); return; }
      return run;
    };
  })();`;
}
