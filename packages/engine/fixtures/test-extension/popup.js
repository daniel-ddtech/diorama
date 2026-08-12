chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  document.querySelector("#active-tab").textContent = tab
    ? `id=${tab.id} url=${tab.url ?? ""}`
    : "no active tab";
});
