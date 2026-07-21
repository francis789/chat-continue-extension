/**
 * Mantém o poller ativo enquanto houver abas "armadas".
 * Timers do content script são fortemente throttled com a aba/minimizado
 * em segundo plano; o service worker não sofre o mesmo limite e envia
 * `cca-tick` ~a cada 400ms para essas abas.
 */
const armedTabs = new Map(); // tabId -> port
let pollInterval = null;

const POLL_MS = 400;

function stopPoller() {
  if (pollInterval == null) return;
  clearInterval(pollInterval);
  pollInterval = null;
}

function ensurePoller() {
  if (pollInterval != null) return;
  pollInterval = setInterval(() => {
    if (armedTabs.size === 0) {
      stopPoller();
      return;
    }
    for (const tabId of armedTabs.keys()) {
      chrome.tabs.sendMessage(tabId, { type: 'cca-tick' }).catch(() => {
        // Aba fechada / content script morto — limpa no disconnect do port.
      });
    }
  }, POLL_MS);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cca-armed') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
    return;
  }

  armedTabs.set(tabId, port);
  ensurePoller();

  port.onDisconnect.addListener(() => {
    const current = armedTabs.get(tabId);
    if (current === port) armedTabs.delete(tabId);
    if (armedTabs.size === 0) stopPoller();
  });
});

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
