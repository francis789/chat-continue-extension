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
  scheduleProgressRefresh();

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
      scheduleProgressRefresh();
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

// Acompanha abas com notificação visual pendente
// tabId -> { notifId, windowId, helperWindowId, reason, at, leftFocus }
const notifiedTabs = new Map();
const FOCUS_CLEAR_GRACE_MS = 2000;
const FALLBACK_NOTIFY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let cachedNotifyIconUrl = null;

/** Abas concluídas (pendentes) vs. ainda em atividade. Alertas não contam como conclusão. */
function isAlertEntry(entry) {
  return !!entry && typeof entry === 'object' && entry.kind === 'alert';
}

function getActivityProgress() {
  let completed = 0;
  const finishedIds = new Set();
  for (const [tabId, entry] of notifiedTabs) {
    if (isAlertEntry(entry)) continue;
    completed += 1;
    finishedIds.add(tabId);
  }
  let running = 0;
  for (const tabId of armedTabs.keys()) {
    if (finishedIds.has(tabId)) continue;
    running += 1;
  }
  return { completed, total: completed + running, running };
}

function formatProgressLabel(completed, total) {
  const done = Math.max(0, completed);
  const all = Math.max(done, total);
  if (done <= 0) return '';
  return `${done}/${Math.max(1, all)}`;
}

function formatProgressBadge(completed, total) {
  const label = formatProgressLabel(completed, total);
  if (!label) return '';
  return label.length <= 4 ? label : String(Math.min(completed, 99));
}

function updateGlobalExtensionBadge() {
  const { completed, total } = getActivityProgress();
  const text = formatProgressBadge(completed, total);
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color: '#e11d48' }).catch(() => {});
  }
}

function buildAlertNotificationCopy(entry) {
  const reason = entry?.reason;
  const classLabel = entry?.classLabel;
  const title = classLabel
    ? `⚠️ Alerta: ${classLabel}`
    : 'Alerta: resposta sem string aceita';
  return {
    title,
    message:
      reason ||
      'A resposta final não contém as strings aceitas nem o texto de parada.',
  };
}

function fillRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
  ctx.fill();
}

let cachedAlertIconUrl = null;

async function renderAlertIconDataUrl() {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  fillRoundRect(ctx, 0, 0, size, size, 28);

  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 52, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#0f172a';
  fillRoundRect(ctx, 58, 32, 12, 44, 6);
  ctx.beginPath();
  ctx.arc(size / 2, 92, 7, 0, Math.PI * 2);
  ctx.fill();

  const out = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(out);
}

async function getAlertIconUrl() {
  if (cachedAlertIconUrl) return cachedAlertIconUrl;
  try {
    const url = await renderAlertIconDataUrl();
    if (url) {
      cachedAlertIconUrl = url;
      return cachedAlertIconUrl;
    }
  } catch (err) {
    console.warn('[CCA] Falha ao gerar ícone de alerta:', err);
  }
  return FALLBACK_NOTIFY_ICON;
}

function buildStoppedNotificationCopy(entry, progress) {
  const reason = entry?.reason;
  const classLabel = entry?.classLabel;
  const completed = Math.max(1, progress?.completed || 1);
  const total = Math.max(completed, progress?.total || completed);
  const prefix = classLabel ? `${classLabel} · ` : '';
  const title = `${prefix}${completed}/${total} abas concluídas`;
  const fallback = reason
    ? `Execução concluída (${reason}).`
    : 'Execução concluída.';
  const remaining = total - completed;
  if (remaining > 0) {
    const extra = remaining === 1 ? '1 ainda em atividade.' : `${remaining} ainda em atividade.`;
    return {
      title,
      message: reason ? `Aba concluída (${reason}). ${extra}` : `Aba concluída. ${extra}`,
    };
  }
  if (total > 1) {
    return {
      title,
      message: reason
        ? `Todas as ${total} abas concluídas (${reason}).`
        : `Todas as ${total} abas em atividade foram concluídas.`,
    };
  }
  return { title, message: fallback };
}

let progressHelperWindowId = null;
let cachedProgressIconUrl = null;
let cachedProgressIconKey = '';

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return `data:image/png;base64,${btoa(binary)}`;
  });
}

async function renderProgressIconDataUrl(completed, total) {
  const label = formatProgressLabel(completed, total) || '1/1';
  const cacheKey = label;
  if (cachedProgressIconUrl && cachedProgressIconKey === cacheKey) {
    return cachedProgressIconUrl;
  }
  if (typeof OffscreenCanvas === 'undefined') return null;
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const blob = await (await fetch(chrome.runtime.getURL('icons/icon128.png'))).blob();
  const bitmap = await createImageBitmap(blob);
  ctx.drawImage(bitmap, 0, 0, size, size);

  const bannerH = Math.round(size * 0.44);
  const y = size - bannerH;
  ctx.fillStyle = '#e11d48';
  ctx.fillRect(0, y, size, bannerH);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fontSize = Math.round(bannerH * 0.7);
  ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  while (fontSize > 18 && ctx.measureText(label).width > size - 10) {
    fontSize -= 1;
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  }
  ctx.fillText(label, size / 2, y + bannerH / 2 + 1);

  const out = await canvas.convertToBlob({ type: 'image/png' });
  cachedProgressIconUrl = await blobToDataUrl(out);
  cachedProgressIconKey = cacheKey;
  return cachedProgressIconUrl;
}

async function pngDataUrlToImageData(dataUrl, size) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bitmap, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

async function setActionIconFromDataUrl(dataUrl) {
  if (!dataUrl || typeof OffscreenCanvas === 'undefined') return;
  try {
    const imageData = {
      48: await pngDataUrlToImageData(dataUrl, 48),
      128: await pngDataUrlToImageData(dataUrl, 128),
    };
    await chrome.action.setIcon({ imageData });
  } catch (err) {
    console.warn('[CCA] Falha ao aplicar ícone com progresso:', err);
  }
}

async function resetActionIcon() {
  cachedProgressIconUrl = null;
  cachedProgressIconKey = '';
  try {
    await chrome.action.setIcon({
      path: { 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    });
  } catch {
    // ignore
  }
  chrome.action.setTitle({
    title: 'Chat Continue Auto — mostrar/ocultar ícone no site',
  }).catch(() => {});
}

async function closeProgressHelper() {
  const id = progressHelperWindowId;
  progressHelperWindowId = null;
  if (id == null) return;
  chrome.windows.remove(id).catch(() => {});
}

async function findProgressHelperTab() {
  if (progressHelperWindowId == null) return null;
  try {
    const tabs = await chrome.tabs.query({ windowId: progressHelperWindowId });
    return tabs?.[0] || null;
  } catch {
    return null;
  }
}

async function ensureProgressHelper(progress, iconUrl) {
  const isAlert = progress?.kind === 'alert';
  const label = isAlert
    ? '!'
    : formatProgressLabel(progress.completed, progress.total) || '1/1';
  const url = chrome.runtime.getURL(
    isAlert
      ? 'taskbar-attention.html?alert=1'
      : `taskbar-attention.html?c=${progress.completed}&t=${progress.total}`
  );
  const payload = {
    type: 'cca-progress-icon',
    kind: isAlert ? 'alert' : 'progress',
    completed: progress.completed,
    total: progress.total,
    iconUrl,
  };

  if (progressHelperWindowId != null) {
    const tab = await findProgressHelperTab();
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {
        chrome.tabs.update(tab.id, { url }).catch(() => {});
      });
      chrome.windows.update(progressHelperWindowId, { drawAttention: true }).catch(() => {});
      return progressHelperWindowId;
    }
    progressHelperWindowId = null;
  }

  try {
    const helper = await chrome.windows.create({
      url,
      type: 'popup',
      focused: false,
      width: 160,
      height: 160,
      left: 0,
      top: 0,
    });
    progressHelperWindowId = helper?.id ?? null;
    if (progressHelperWindowId != null) {
      await chrome.windows.update(progressHelperWindowId, { state: 'minimized' }).catch(() => {});
      await chrome.windows.update(progressHelperWindowId, { drawAttention: true }).catch(() => {});
      const tab = await findProgressHelperTab();
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[CCA] Falha ao criar janela do ícone de progresso:', err);
  }
  return progressHelperWindowId;
}

async function applyProgressVisuals(progress) {
  updateGlobalExtensionBadge();
  const badge = formatProgressBadge(progress.completed, progress.total);
  for (const [tabId, entry] of notifiedTabs) {
    if (isAlertEntry(entry)) {
      chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#d97706' }).catch(() => {});
      continue;
    }
    chrome.action.setBadgeText({ tabId, text: badge }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#e11d48' }).catch(() => {});
  }

  if (progress.completed <= 0) {
    let hasAlert = false;
    for (const entry of notifiedTabs.values()) {
      if (isAlertEntry(entry)) {
        hasAlert = true;
        break;
      }
    }
    if (hasAlert) {
      chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#d97706' }).catch(() => {});
      const alertIcon = await getAlertIconUrl();
      if (alertIcon) await setActionIconFromDataUrl(alertIcon);
      await ensureProgressHelper({ completed: 1, total: 1, kind: 'alert' }, alertIcon);
      return alertIcon;
    }
    await resetActionIcon();
    await closeProgressHelper();
    return null;
  }

  const iconUrl = await renderProgressIconDataUrl(progress.completed, progress.total);
  if (iconUrl) {
    await setActionIconFromDataUrl(iconUrl);
  }
  chrome.action
    .setTitle({
      title: `${formatProgressLabel(progress.completed, progress.total)} abas concluídas`,
    })
    .catch(() => {});
  await ensureProgressHelper(progress, iconUrl);
  return iconUrl;
}

function entryNotifId(entry) {
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.notifId;
}

function closeHelperWindow(entry) {
  const helperId = entry?.helperWindowId;
  if (helperId == null) return;
  entry.helperWindowId = null;
  chrome.windows.remove(helperId).catch(() => {});
}

function clearTabVisualNotification(tabId, { notifyContent = true } = {}) {
  if (tabId == null) return;
  const entry = notifiedTabs.get(tabId);
  const notifId = entryNotifId(entry);
  if (notifId) {
    chrome.notifications.clear(notifId).catch(() => {});
  }
  closeHelperWindow(entry);
  notifiedTabs.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  updateGlobalExtensionBadge();
  if (notifyContent) {
    chrome.tabs.sendMessage(tabId, { type: 'cca-clear-notification' }).catch(() => {});
  }
  scheduleProgressRefresh();
}

async function getNotificationIconUrl() {
  if (cachedNotifyIconUrl) return cachedNotifyIconUrl;
  try {
    const res = await fetch(chrome.runtime.getURL('icons/icon128.png'));
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    cachedNotifyIconUrl = `data:image/png;base64,${btoa(binary)}`;
    return cachedNotifyIconUrl;
  } catch (err) {
    console.warn('[CCA] Falha ao ler ícone da notificação:', err);
    return FALLBACK_NOTIFY_ICON;
  }
}

async function createNativeNotification(notifId, { title, message, silent, iconUrl }) {
  const resolvedIcon = iconUrl || (await getNotificationIconUrl());
  const options = {
    type: 'basic',
    iconUrl: resolvedIcon,
    title: title || 'Chat Continue Auto',
    message: message || 'Execução concluída.',
    priority: 2,
    requireInteraction: true,
    silent: !!silent,
  };
  try {
    await chrome.notifications.create(notifId, options);
    return;
  } catch (err) {
    console.warn('[CCA] Erro ao criar notificação, tentando ícone fallback:', err);
  }
  await chrome.notifications.create(notifId, {
    ...options,
    iconUrl: FALLBACK_NOTIFY_ICON,
  });
}

let progressRefreshTimer = null;

function scheduleProgressRefresh() {
  if (progressRefreshTimer != null) return;
  progressRefreshTimer = setTimeout(() => {
    progressRefreshTimer = null;
    void refreshProgressNotifications();
  }, 50);
}

async function refreshProgressNotifications() {
  const progress = getActivityProgress();
  const iconUrl = await applyProgressVisuals(progress);
  for (const entry of notifiedTabs.values()) {
    if (isAlertEntry(entry)) continue;
    const notifId = entryNotifId(entry);
    if (!notifId) continue;
    const copy = buildStoppedNotificationCopy(entry, progress);
    const patch = {
      title: copy.title,
      message: copy.message,
    };
    if (iconUrl) patch.iconUrl = iconUrl;
    try {
      await chrome.notifications.update(notifId, patch);
    } catch {
      // notificação já fechada pelo sistema
    }
  }
}

async function flashTaskbarIcon(windowId) {
  if (windowId == null) return;
  try {
    await chrome.windows.update(windowId, { drawAttention: true });
  } catch {
    // ignore
  }
}

async function handleNotifyStopped(msg, sender) {
  const tabId = sender?.tab?.id;
  let windowId = sender?.tab?.windowId;

  if (tabId == null) return { ok: false, error: 'Aba indisponível.' };

  const permission = await chrome.notifications.getPermissionLevel().catch(() => 'granted');
  if (permission === 'denied') {
    return { ok: false, error: 'Notificações bloqueadas para esta extensão no Brave.' };
  }

  if (windowId == null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      windowId = tab?.windowId;
    } catch {
      // ignore
    }
  }

  const prev = notifiedTabs.get(tabId);
  const notifId = `cca-stopped-${tabId}`;
  const entry = {
    notifId,
    windowId: windowId ?? null,
    reason: msg?.reason || '',
    classLabel: msg?.classLabel || '',
    kind: 'stopped',
    at: Date.now(),
    leftFocus: false,
  };
  notifiedTabs.set(tabId, entry);
  if (prev) {
    const prevId = entryNotifId(prev);
    if (prevId && prevId !== notifId) {
      chrome.notifications.clear(prevId).catch(() => {});
    }
    closeHelperWindow(prev);
  }

  const progress = getActivityProgress();
  const copy = buildStoppedNotificationCopy(entry, progress);
  const iconUrl = await applyProgressVisuals(progress);

  try {
    await createNativeNotification(notifId, {
      title: copy.title,
      message: copy.message,
      silent: true,
      iconUrl,
    });
  } catch (err) {
    console.warn('[CCA] Erro ao criar notificação:', err);
    return { ok: false, error: err?.message || String(err) };
  }

  scheduleProgressRefresh();
  await flashTaskbarIcon(windowId);
  return { ok: true, completed: progress.completed, total: progress.total };
}

async function handleNotifyAlert(msg, sender) {
  const tabId = sender?.tab?.id;
  let windowId = sender?.tab?.windowId;

  if (tabId == null) return { ok: false, error: 'Aba indisponível.' };

  const permission = await chrome.notifications.getPermissionLevel().catch(() => 'granted');
  if (permission === 'denied') {
    return { ok: false, error: 'Notificações bloqueadas para esta extensão no Brave.' };
  }

  if (windowId == null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      windowId = tab?.windowId;
    } catch {
      // ignore
    }
  }

  const prev = notifiedTabs.get(tabId);
  const notifId = `cca-alert-${tabId}`;
  const entry = {
    notifId,
    windowId: windowId ?? null,
    reason: msg?.reason || '',
    classLabel: msg?.classLabel || '',
    kind: 'alert',
    at: Date.now(),
    leftFocus: false,
  };
  notifiedTabs.set(tabId, entry);
  if (prev) {
    const prevId = entryNotifId(prev);
    if (prevId && prevId !== notifId) {
      chrome.notifications.clear(prevId).catch(() => {});
    }
    closeHelperWindow(prev);
  }

  const copy = buildAlertNotificationCopy(entry);
  const iconUrl = await getAlertIconUrl();
  await applyProgressVisuals(getActivityProgress());

  try {
    await createNativeNotification(notifId, {
      title: copy.title,
      message: copy.message,
      silent: false,
      iconUrl,
    });
  } catch (err) {
    console.warn('[CCA] Erro ao criar notificação de alerta:', err);
    return { ok: false, error: err?.message || String(err) };
  }

  scheduleProgressRefresh();
  await flashTaskbarIcon(windowId);
  return { ok: true, kind: 'alert' };
}

function shouldClearOnFocus(entry) {
  if (!entry) return false;
  if (Date.now() - entry.at < FOCUS_CLEAR_GRACE_MS) return false;
  return !!entry.leftFocus;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (msg?.type === 'cca-notify-running') {
    if (tabId != null) {
      if (notifiedTabs.has(tabId)) {
        clearTabVisualNotification(tabId, { notifyContent: false });
      }
      chrome.action.setBadgeText({ tabId, text: '▶' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' }).catch(() => {});
      scheduleProgressRefresh();
    }
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === 'cca-notify-stopped') {
    handleNotifyStopped(msg, sender)
      .then((result) => sendResponse?.(result))
      .catch((err) => {
        console.warn('[CCA] cca-notify-stopped:', err);
        sendResponse?.({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (msg?.type === 'cca-notify-alert') {
    handleNotifyAlert(msg, sender)
      .then((result) => sendResponse?.(result))
      .catch((err) => {
        console.warn('[CCA] cca-notify-alert:', err);
        sendResponse?.({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (msg?.type === 'cca-get-progress') {
    const progress = getActivityProgress();
    sendResponse?.({
      ok: true,
      completed: progress.completed,
      total: progress.total,
      iconUrl: cachedProgressIconUrl,
    });
    return true;
  }

  if (msg?.type === 'cca-clear-notification') {
    if (tabId != null) {
      clearTabVisualNotification(tabId, { notifyContent: false });
    }
    sendResponse?.({ ok: true });
    return true;
  }
});

// Ao ativar uma aba com notificação pendente, limpa o badge
chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabId = activeInfo.tabId;
  const entry = notifiedTabs.get(tabId);
  if (!entry) return;
  if (Date.now() - entry.at < FOCUS_CLEAR_GRACE_MS) return;
  clearTabVisualNotification(tabId);
});

// Só limpa ao voltar para a janela depois de ela ter perdido o foco
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === progressHelperWindowId) return;
  for (const entry of notifiedTabs.values()) {
    if (windowId === chrome.windows.WINDOW_ID_NONE || windowId !== entry.windowId) {
      entry.leftFocus = true;
    }
  }
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ windowId, active: true }, (tabs) => {
    const activeTab = tabs?.[0];
    if (activeTab?.id == null) return;
    const entry = notifiedTabs.get(activeTab.id);
    if (!shouldClearOnFocus(entry)) return;
    clearTabVisualNotification(activeTab.id);
  });
});

chrome.windows.onRemoved.addListener((removedWindowId) => {
  if (progressHelperWindowId === removedWindowId) {
    progressHelperWindowId = null;
  }
  for (const entry of notifiedTabs.values()) {
    if (entry.helperWindowId === removedWindowId) {
      entry.helperWindowId = null;
    }
  }
});

// Ao clicar na notificação, foca a aba correspondente e limpa os alertas
chrome.notifications.onClicked.addListener((notifId) => {
  for (const [tabId, entry] of notifiedTabs.entries()) {
    if (entryNotifId(entry) === notifId) {
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

chrome.notifications.onClosed.addListener((notifId, byUser) => {
  if (!byUser) return;
  for (const [tabId, entry] of notifiedTabs.entries()) {
    if (entryNotifId(entry) === notifId) {
      clearTabVisualNotification(tabId);
      break;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabVisualNotification(tabId, { notifyContent: false });
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

