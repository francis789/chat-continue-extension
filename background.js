chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'cca-toggle-panel' });
  } catch {
    // Aba sem content script (site não listado) — ignora.
  }
});
