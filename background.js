/**
 * Mantém o poller ativo enquanto houver abas "armadas".
 * Timers do content script são fortemente throttled com a aba/minimizado
 * em segundo plano; o service worker não sofre o mesmo limite e envia
 * `cca-tick` ~a cada 400ms para essas abas.
 */
const armedTabs = new Map(); // tabId -> { port, restoreAutoDiscardable }
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
    const now = Date.now();
    for (const [tabId, entry] of armedTabs) {
      try {
        // Mensagens pela porta longa mantêm o service worker ativo no MV3 e
        // acordam o content script mesmo quando a aba está sem foco.
        entry.port.postMessage({ type: 'cca-tick', now });
      } catch {
        // Defesa para uma porta que desconectou entre os ticks.
        if (armedTabs.get(tabId) === entry) armedTabs.delete(tabId);
      }
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

  const previous = armedTabs.get(tabId);
  const restoreAutoDiscardable =
    previous?.restoreAutoDiscardable ?? (port.sender?.tab?.autoDiscardable !== false);
  const entry = { port, restoreAutoDiscardable };
  armedTabs.set(tabId, entry);
  ensurePoller();

  // Evita que o Memory Saver descarte a página no meio de uma execução.
  // A configuração é restaurada quando a extensão desarma normalmente.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

  port.onDisconnect.addListener(() => {
    const current = armedTabs.get(tabId);
    if (current === entry) {
      armedTabs.delete(tabId);
      chrome.tabs
        .update(tabId, { autoDiscardable: restoreAutoDiscardable })
        .catch(() => {});
    }
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
    await chrome.tabs.sendMessage(tab.id, { type: 'cca-toggle-icon' });
  } catch (err) {
    console.warn('[CCA] Content script não respondeu:', err);
  }
});
