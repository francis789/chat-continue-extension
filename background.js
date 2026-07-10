async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'cca-ping' });
    if (ping?.ok) return true;
  } catch {
    // Ainda não injetado nesta aba.
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    return true;
  } catch (err) {
    console.warn('[CCA] Falha ao injetar content script:', err);
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    // chrome://, Web Store, etc. — não dá para injetar.
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d1242f' });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: 'Abra um chat (ChatGPT, Claude, Gemini…) e clique de novo',
    });
    return;
  }

  await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'cca-open-panel' });
  } catch (err) {
    console.warn('[CCA] Painel não respondeu:', err);
  }
});
