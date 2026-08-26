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

// Acompanha abas com notificação visual pendente (tabId -> notifId)
const notifiedTabs = new Map();

function updateGlobalExtensionBadge() {
  if (notifiedTabs.size > 0) {
    chrome.action.setBadgeText({ text: '●' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#e53e3e' }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function clearTabVisualNotification(tabId) {
  if (tabId == null) return;
  const notifId = notifiedTabs.get(tabId);
  if (notifId) {
    chrome.notifications.clear(notifId).catch(() => {});
  }
  notifiedTabs.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  updateGlobalExtensionBadge();
  chrome.tabs.sendMessage(tabId, { type: 'cca-clear-notification' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;

  if (msg?.type === 'cca-notify-running') {
    if (tabId != null) {
      chrome.action.setBadgeText({ tabId, text: '▶' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' }).catch(() => {});
    }
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === 'cca-notify-stopped') {
    if (tabId != null) {
      const notifId = `cca-stopped-${tabId}`;
      notifiedTabs.set(tabId, notifId);
      chrome.action.setBadgeText({ tabId, text: '✔' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
      updateGlobalExtensionBadge();

      // Notificação silenciosa (sem som) para gerar o selo/bolinha no ícone do navegador na barra de tarefas do Windows
      chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Chat Continue Auto',
        message: msg.reason ? `Execução concluída (${msg.reason}).` : 'Execução concluída.',
        silent: true,
        priority: 1,
      }).catch(() => {});
    }
    if (windowId != null) {
      chrome.windows.update(windowId, { drawAttention: true }).catch(() => {});
    } else if (tabId != null) {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab?.windowId != null) {
          chrome.windows.update(tab.windowId, { drawAttention: true }).catch(() => {});
        }
      }).catch(() => {});
    }
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === 'cca-clear-notification') {
    if (tabId != null) {
      clearTabVisualNotification(tabId);
    }
    sendResponse?.({ ok: true });
    return true;
  }
});

// Ao ativar/focar uma aba com notificação pendente, limpa o badge e a notificação
chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabId = activeInfo.tabId;
  if (notifiedTabs.has(tabId)) {
    clearTabVisualNotification(tabId);
  }
});

// Ao focar a janela, se a aba ativa tiver notificação pendente, limpa
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ windowId, active: true }, (tabs) => {
    const activeTab = tabs?.[0];
    if (activeTab?.id && notifiedTabs.has(activeTab.id)) {
      clearTabVisualNotification(activeTab.id);
    }
  });
});

// Ao clicar na notificação, foca a aba correspondente e limpa os alertas
chrome.notifications.onClicked.addListener((notifId) => {
  for (const [tabId, id] of notifiedTabs.entries()) {
    if (id === notifId) {
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
      chrome.tabs.get(tabId).then((tab) => {
        if (tab?.windowId) {
          chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
      }).catch(() => {});
      clearTabVisualNotification(tabId);
      break;
    }
  }
});

chrome.notifications.onClosed.addListener((notifId) => {
  for (const [tabId, id] of notifiedTabs.entries()) {
    if (id === notifId) {
      clearTabVisualNotification(tabId);
      break;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabVisualNotification(tabId);
});

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

