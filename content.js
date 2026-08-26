(() => {
  'use strict';

  // Evita UI/interval duplicados se o background reinjetar o script.
  if (window.__CCA_LOADED__) {
    window.dispatchEvent(new CustomEvent('cca-reopen'));
    return;
  }
  window.__CCA_LOADED__ = true;

  const STORAGE_KEY = 'cca_settings';
  const DEFAULT_SAVED_TEXTS = [
    {
      text: 'faça o sumário',
      tag: 'Sumário',
    },
    {
      text: 'faça a classificação',
      tag: 'Sumário',
    },
    {
      text: 'Execute o comando.',
      tag: 'Geral',
    },
    {
      text: 'Execute o comando. PROIBIDO qualquer tipo de texto antes ou depois do resumo.',
      tag: 'Resumos',
    },
    {
      text: 'Execute o comando. Lembre-se: use obrigatoriamente a sintaxe =tag= (=id=, =pai=, =tipo=, =texto=, =fonte=, =detalhe=) e nunca dois pontos.',
      tag: 'Mapas',
    },
  ];
  const DEFAULT_MARKER_MAX = {
    '=ff=': 100,
    'assunto:': 0,
    '=fim=': 1,
  };
  const DEFAULTS = {
    text: DEFAULT_SAVED_TEXTS[0].text,
    savedTexts: DEFAULT_SAVED_TEXTS,
    times: 100,
    /** Strings alternativas aceitas na resposta da IA (separadas por ponto e vírgula). */
    marker: '=ff=;Assunto:;=FIM=',
    /** Mínimo de ocorrências de uma das strings aceitas na última resposta. */
    minNew: 1,
    /** Limite máximo individual por string aceita na página (0 = sem limite). */
    markerMax: { ...DEFAULT_MARKER_MAX },
    /** Texto que encerra as inserções após concluir a resposta da IA. */
    stopText: 'COMANDO FINALIZADO',
    /**
     * Textos (vírgula) que, se presentes no título, impedem a exclusão
     * automática de notebooks não fixados no NotebookLM.
     */
    protectTitles: '',
    /** Seção NotebookLM — limpeza expandida no painel. */
    nlmSectionOpen: false,
    /** Exibir ou ocultar o ícone da extensão no site. */
    visible: true,
  };
  /** Default antigo — migra para o novo se o usuário nunca personalizou. */
  const LEGACY_DEFAULT_TEXTS = new Set(['continue', 'execute o comando']);
  const LEGACY_DEFAULT_MARKERS = new Set([
    '=ff=',
    '=ff=; blueprint',
    '=ff=; **Item',
    '=ff=;### Item',
    '=ff=; ### Item',
    '=ff=;Assunto:',
  ]);
  const LEGACY_DEFAULT_TIMES = 4;
  const LEGACY_DEFAULT_MAX_TOTAL = 0;

  /** Delay após a IA parar, antes de digitar (UI estabilizar). */
  const AFTER_IDLE_MS = 1200;
  /** Delay entre digitar e enviar. */
  const BEFORE_SEND_MS = 250;
  /** Polling de estado gerando/idle. */
  const POLL_MS = 400;
  /** Tempo de parede sem mudança para considerar texto/marcador estável. */
  const STABLE_MS = 2400;
  /** Intervalo mínimo entre tentativas de envio após falha. */
  const SEND_RETRY_MS = 2000;
  /** Tentativas de inserção no composer por envio. */
  const INSERT_ATTEMPTS = 5;
  /** Se pendingSend ficar preso além disso, libera (envio travado). */
  const PENDING_SEND_TIMEOUT_MS = 45000;
  /** Sem novo envio por tanto tempo (e IA parada) → força novo ciclo. */
  const STUCK_WATCH_MS = 150000;

  const state = {
    armed: false,
    remaining: 0,
    text: DEFAULTS.text,
    /** Biblioteca de mensagens que podem ser selecionadas no campo principal. */
    savedTexts: [...DEFAULTS.savedTexts],
    times: DEFAULTS.times,
    /** idle | watch | streaming */
    phase: 'idle',
    pendingSend: false,
    /** Timestamp em que pendingSend ficou true (0 = livre). */
    pendingSendSince: 0,
    lastSendAt: 0,
    /** Última tentativa de envio (sucesso ou falha) — para backoff. */
    lastSendAttemptAt: 0,
    /** Repetir a mesma inserção sem aguardar outra resposta (último envio falhou). */
    retrySend: false,
    /** Último nudge do watchdog de progresso travado. */
    lastStuckNudgeAt: 0,
    panelOpen: false,
    /** Assinatura da última resposta (tamanho) para detectar estabilização. */
    lastReplySig: '',
    /** Elemento da última resposta; detecta até uma nova resposta com texto idêntico. */
    lastReplyEl: null,
    /** Quantidade de turnos no seletor que encontrou a última resposta. */
    lastReplyCount: null,
    /** Seletor/fallback usado no snapshot, para comparar contagens equivalentes. */
    lastReplySource: '',
    /** Um sinal forte de geração foi visto neste ciclo. */
    sawHardStreaming: false,
    stableTicks: 0,
    /** Timestamp em que a assinatura da resposta passou a ficar igual (0 = mudou). */
    replyStableSince: 0,
    sawStreaming: false,
    /** Lista de strings aceitas na resposta, separadas por ponto e vírgula. */
    marker: DEFAULTS.marker,
    minNew: DEFAULTS.minNew,
    /** Limite máximo individual por string aceita na página (0 = sem limite). */
    markerMax: { ...DEFAULTS.markerMax },
    /** Texto de parada: encerra somente após a resposta da IA terminar. */
    stopText: DEFAULTS.stopText,
    /** Contagem do texto de parada no Iniciar (null = ainda não registrada). */
    stopTextBaseline: null,
    /** Contagem do marcador no momento do último envio (null = registrar). */
    markerBaseline: null,
    /** Maior contagem já vista desde a baseline (imune a DOM virtualizado). */
    markerLast: 0,
    /** Baseline por string aceita (chave normalizada). */
    markerBaselineCounts: null,
    /** Maior contagem vista por string aceita no ciclo atual. */
    markerLastCounts: null,
    /** Ticks consecutivos sem ocorrência nova (fallback; preferir wall-clock). */
    markerStableTicks: 0,
    /** Timestamp em que a contagem do marcador parou de crescer (0 = cresceu). */
    markerStableSince: 0,
    /**
     * Última inserção já enviada; ainda aguardando a IA terminar de responder
     * (e satisfazer a lista de strings aceita) antes de encerrar de vez.
     */
    finishing: false,
    /** Temporizador: timestamp de início (0 = nunca iniciado). */
    timerStart: 0,
    /** Temporizador: timestamp de parada (válido só com timerRunning=false). */
    timerStop: 0,
    /** Temporizador em contagem. */
    timerRunning: false,
    /**
     * Textos (vírgula) que protegem notebooks da exclusão em massa
     * se aparecerem no título.
     */
    protectTitles: DEFAULTS.protectTitles,
    /** Seção NotebookLM — limpeza expandida. */
    nlmSectionOpen: DEFAULTS.nlmSectionOpen,
    /** Exclusão em massa de notebooks em andamento. */
    deletingNotebooks: false,
    /** Exibir ou ocultar o ícone da extensão no site. */
    visible: DEFAULTS.visible,
  };

  let rootEl = null;
  let statusEl = null;
  let fabEl = null;
  /** Porta longa com o SW enquanto armado (evita throttle de aba em background). */
  let armedPort = null;
  let armedPortReconnectQueued = false;
  /** Delays que também podem ser liberados pelos pulsos vindos do SW. */
  const pendingSleeps = new Set();

  let extVersion = '?';
  try {
    extVersion = chrome.runtime.getManifest().version;
  } catch {
    // contexto invalidado — segue sem versão
  }

  // ─── Notificação Visual na Aba (Play / Check) e Barra de Tarefas ──

  let tabVisualState = 'idle'; // 'idle' | 'running' | 'finished'
  let notificationSetAt = 0;
  let originalDocumentTitle = '';
  let originalFaviconHrefs = [];
  let originalFaviconElements = [];
  let faviconObserver = null;
  let titleObserver = null;

  /** Coleta os favicons originais da página antes de aplicar o ícone customizado. */
  function captureOriginalFavicons() {
    if (originalFaviconElements.length > 0) return;
    const links = Array.from(
      document.querySelectorAll(
        "link[rel*='icon'], link[rel*='shortcut'], link[rel*='apple-touch-icon']"
      )
    );
    if (links.length > 0) {
      originalFaviconElements = links.map((l) => ({
        rel: l.getAttribute('rel') || 'icon',
        type: l.getAttribute('type') || '',
        sizes: l.getAttribute('sizes') || '',
        href: l.getAttribute('href') || l.href,
      }));
      originalFaviconHrefs = links.map((l) => l.getAttribute('href') || l.href);
    } else {
      originalFaviconElements = [{ rel: 'icon', type: '', sizes: '', href: '/favicon.ico' }];
      originalFaviconHrefs = ['/favicon.ico'];
    }
  }

  /** Ícone SVG com símbolo de Play (▶) em verde para quando estiver em atividade. */
  function getPlayFaviconSvgDataUrl() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" fill="#0f172a"/>
      <circle cx="16" cy="16" r="13" fill="#10b981"/>
      <polygon points="12.5,9.5 23.5,16 12.5,22.5" fill="#ffffff"/>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  /** Ícone SVG com símbolo de Check (✔) e bolinha de notificação para quando terminar. */
  function getCheckFaviconSvgDataUrl() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <defs>
        <filter id="cca-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.4"/>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill="#0f172a"/>
      <circle cx="16" cy="16" r="13" fill="#2563eb"/>
      <!-- Checkmark -->
      <path d="M9 16.5l4.5 4.5 9.5-9.5" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- Bolinha de Notificação Vermelha com contorno branco -->
      <circle cx="23" cy="9" r="6.5" fill="#ffffff" filter="url(#cca-shadow)"/>
      <circle cx="23" cy="9" r="4.5" fill="#ef4444"/>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  /** Aplica o favicon SVG customizado no DOM. */
  function applyCustomFavicon(svgUrl) {
    const existing = Array.from(
      document.querySelectorAll(
        "link[rel*='icon'], link[rel*='shortcut'], link[rel*='apple-touch-icon']"
      )
    );
    for (const el of existing) {
      if (el.dataset.ccaCustom !== 'true') {
        el.remove();
      }
    }

    let link = document.querySelector('link[data-cca-custom="true"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      link.dataset.ccaCustom = 'true';
      document.head.appendChild(link);
    }
    link.href = svgUrl;
  }

  function ensureVisualObservers() {
    if (!faviconObserver) {
      faviconObserver = new MutationObserver(() => {
        if (tabVisualState === 'running') {
          const current = document.querySelector('link[data-cca-custom="true"]');
          if (!current) applyCustomFavicon(getPlayFaviconSvgDataUrl());
        } else if (tabVisualState === 'finished') {
          const current = document.querySelector('link[data-cca-custom="true"]');
          if (!current) applyCustomFavicon(getCheckFaviconSvgDataUrl());
        }
      });
      faviconObserver.observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'rel'],
      });
    }

    if (!titleObserver) {
      titleObserver = new MutationObserver(() => {
        if (tabVisualState === 'running') {
          if (!document.title.startsWith('▶ ')) {
            document.title = `▶ ${document.title.replace(/^[▶✔🔴●]\s*/, '')}`;
          }
        } else if (tabVisualState === 'finished') {
          if (!document.title.startsWith('✔ ')) {
            document.title = `✔ ${document.title.replace(/^[▶✔🔴●]\s*/, '')}`;
          }
        }
      });
      const titleEl = document.querySelector('title');
      if (titleEl) {
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
    }
  }

  /** Ativa o ícone de Play (▶) na aba enquanto a extensão estiver em atividade. */
  function setRunningTabVisual() {
    tabVisualState = 'running';
    captureOriginalFavicons();
    if (!originalDocumentTitle) {
      originalDocumentTitle = document.title.replace(/^[▶✔🔴●]\s*/, '') || '';
    }

    applyCustomFavicon(getPlayFaviconSvgDataUrl());
    document.title = `▶ ${originalDocumentTitle}`;
    ensureVisualObservers();

    try {
      chrome.runtime.sendMessage({ type: 'cca-notify-running' }).catch(() => {});
    } catch {
      // ignore
    }
  }

  /** Ativa o ícone de Check (✔) na aba e a notificação no Brave/barra de tarefas ao terminar. */
  function setFinishedTabVisual(reason = '') {
    tabVisualState = 'finished';
    notificationSetAt = Date.now();
    captureOriginalFavicons();
    if (!originalDocumentTitle) {
      originalDocumentTitle = document.title.replace(/^[▶✔🔴●]\s*/, '') || '';
    }

    applyCustomFavicon(getCheckFaviconSvgDataUrl());
    document.title = `✔ ${originalDocumentTitle}`;
    ensureVisualObservers();

    // Notifica o background para gerar a notificação no Windows e destacar a barra de tarefas
    try {
      chrome.runtime
        .sendMessage({
          type: 'cca-notify-stopped',
          reason,
        })
        .then((res) => {
          if (res && res.ok === false && res.error) {
            setStatus(`Falha ao notificar na barra de tarefas: ${res.error}`);
          }
        })
        .catch(() => {});
    } catch {
      // ignore
    }

    try {
      if (typeof navigator.setAppBadge === 'function') {
        navigator.setAppBadge().catch(() => {});
      }
    } catch {
      // ignore
    }

    dlog('Visual de conclusão ativado (ícone ✔ na aba e notificação na barra de tarefas):', reason);
  }

  /** Remove os ícones customizados e restaura o favicon e título originais da página. */
  function clearTabVisuals() {
    if (tabVisualState === 'idle') return;
    tabVisualState = 'idle';
    notificationSetAt = 0;

    // Desconecta observadores
    if (faviconObserver) {
      faviconObserver.disconnect();
      faviconObserver = null;
    }
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }

    // Remove favicon customizado
    const customLinks = document.querySelectorAll('link[data-cca-custom="true"]');
    customLinks.forEach((el) => el.remove());

    // Restaura favicons originais
    if (originalFaviconElements.length > 0) {
      for (const orig of originalFaviconElements) {
        const link = document.createElement('link');
        link.rel = orig.rel || 'icon';
        if (orig.type) link.type = orig.type;
        if (orig.sizes) link.sizes = orig.sizes;
        link.href = orig.href;
        document.head.appendChild(link);
      }
    } else {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = originalFaviconHrefs[0] || '/favicon.ico';
      document.head.appendChild(link);
    }
    originalFaviconElements = [];
    originalFaviconHrefs = [];

    // Restaura título
    if (
      document.title.startsWith('▶ ') ||
      document.title.startsWith('✔ ') ||
      document.title.startsWith('🔴 ') ||
      document.title.startsWith('● ')
    ) {
      document.title = document.title.replace(/^[▶✔🔴●]\s*/, '');
    }
    originalDocumentTitle = '';

    // Notifica background para limpar badge da extensão e notificação da barra de tarefas
    try {
      chrome.runtime.sendMessage({ type: 'cca-clear-notification' }).catch(() => {});
    } catch {
      // ignore
    }

    try {
      if (typeof navigator.clearAppBadge === 'function') {
        navigator.clearAppBadge().catch(() => {});
      }
    } catch {
      // ignore
    }

    dlog('Visuais da aba restaurados ao padrão.');
  }

  // Remove o visual de conclusão ao focar ou clicar na aba
  function onUserInteractedWithTab(e) {
    if (tabVisualState === 'finished') {
      if (Date.now() - notificationSetAt < 600) return;
      if (e && e.isTrusted === false) return;
      if (e?.target && rootEl && rootEl.contains(e.target)) return;
      clearTabVisuals();
    }
  }

  window.addEventListener('focus', onUserInteractedWithTab, true);
  document.addEventListener('pointerdown', onUserInteractedWithTab, true);
  document.addEventListener('click', onUserInteractedWithTab, true);
  document.addEventListener('keydown', onUserInteractedWithTab, true);


  /** Log de diagnóstico — abra o console (F12) e filtre por [CCA]. */
  function dlog(...args) {
    try {
      console.log('[CCA]', ...args);
    } catch {
      // ignore
    }
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function defaultTagForText(text) {
    const found = DEFAULT_SAVED_TEXTS.find((item) => item.text === text);
    return found?.tag || 'Geral';
  }

  function normalizeSavedTexts(value) {
    if (!Array.isArray(value)) return [];
    const result = [];
    const seenTexts = new Set();
    for (const item of value) {
      let text = '';
      let tag = '';
      if (typeof item === 'string') {
        text = item.trim();
        tag = defaultTagForText(text);
      } else if (item && typeof item === 'object') {
        text = typeof item.text === 'string' ? item.text.trim() : '';
        tag = typeof item.tag === 'string' ? item.tag.trim() : '';
        if (!tag) tag = defaultTagForText(text);
      }
      if (text && !seenTexts.has(text)) {
        seenTexts.add(text);
        result.push({ text, tag });
      }
    }
    return result;
  }

  // ─── Detecção por site ───────────────────────────────────────────

  function host() {
    return location.hostname;
  }

  function isChatGPT() {
    return /chatgpt\.com$|chat\.openai\.com$/.test(host());
  }

  function isClaude() {
    return /claude\.ai$/.test(host());
  }

  function isGemini() {
    return /gemini\.google\.com$|aistudio\.google\.com$/.test(host());
  }

  function isDeepSeek() {
    return /chat\.deepseek\.com$/.test(host());
  }

  function isPerplexity() {
    return /perplexity\.ai$/.test(host());
  }

  function isNotebookLM() {
    return /notebooklm\.google\.com$|notebook\.google\.com$/.test(host());
  }

  function visible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function queryAll(sel, { requireVisible = true } = {}) {
    const list = Array.from(document.querySelectorAll(sel));
    return requireVisible ? list.filter(visible) : list;
  }

  function findStopButton() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop Response"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Parar de gerar"]',
      'button[aria-label="Parar resposta"]',
      'button[aria-label="Parar"]',
      'button[aria-label="Interromper resposta"]',
    ];
    for (const sel of selectors) {
      const el = queryAll(sel)[0];
      if (el) return el;
    }
    for (const btn of queryAll('button')) {
      const t = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '')
        .trim()
        .toLowerCase();
      if (
        t === 'stop' ||
        t === 'parar' ||
        t.includes('stop streaming') ||
        t.includes('stop generating') ||
        t.includes('stop response') ||
        t.includes('parar de gerar') ||
        t.includes('parar resposta') ||
        t.includes('parar gera') ||
        t.includes('interromper')
      ) {
        return btn;
      }
      // Ícone quadrado de stop sem label útil (ChatGPT)
      if (
        btn.querySelector('svg') &&
        (btn.closest('form') || btn.closest('[class*="composer"]')) &&
        /stop|square|rect/i.test(btn.innerHTML) &&
        !/send|enviar|submit/i.test(t)
      ) {
        // Heurística fraca — só se send-button sumiu
        if (!document.querySelector('button[data-testid="send-button"]')) return btn;
      }
    }
    return null;
  }

  /** Sinais confiáveis: só existem no DOM enquanto a IA realmente gera. */
  function hasHardStreamingSignal() {
    if (findStopButton()) return true;
    return !!document.querySelector('.result-streaming, [data-is-streaming="true"]');
  }

  /**
   * Sinais fracos: blocos de thinking/reasoning ficam no DOM depois que a
   * resposta termina (Claude/ChatGPT), então sozinhos não provam geração.
   */
  function hasSoftStreamingSignal() {
    if (queryAll('[data-testid*="thinking"], [data-testid*="reasoning"]').length) {
      return true;
    }
    // ChatGPT: logo após nosso envio o send-button some antes do stop aparecer.
    if (
      isChatGPT() &&
      state.phase !== 'idle' &&
      Date.now() - state.lastSendAt > 600 &&
      Date.now() - state.lastSendAt < 15000
    ) {
      const send = document.querySelector('button[data-testid="send-button"]');
      // Composer vazio no ChatGPT mostra o botão de voz no lugar do send —
      // isso é estado idle, não geração.
      const voice = document.querySelector(
        'button[data-testid="composer-speech-button"], button[aria-label*="voice" i], button[aria-label*="dictation" i], button[aria-label*="ditar" i]'
      );
      if (!send && !voice) return true;
    }
    return false;
  }

  function isSendButtonReady() {
    const btn =
      document.querySelector('button[data-testid="send-button"]') ||
      queryAll('button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label*="Enviar mensagem" i]')[0];
    if (!btn) return false;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    return visible(btn);
  }

  function isGenerating() {
    if (hasHardStreamingSignal()) return true;
    if (hasSoftStreamingSignal()) {
      // Sinal fraco pode ser um bloco de thinking de resposta JÁ concluída
      // preso no DOM. Se o texto da conversa está parado há ~3s, ignora.
      if (replyStableFor(3200) || state.stableTicks >= 8) return false;
      return true;
    }
    return false;
  }

  function replyStableFor(ms) {
    return state.replyStableSince > 0 && Date.now() - state.replyStableSince >= ms;
  }

  function pageLikelyBackgrounded() {
    try {
      return document.hidden || document.visibilityState === 'hidden';
    } catch {
      return false;
    }
  }

  /** Última bolha conhecida do assistente nas interfaces suportadas. */
  function getLastAssistantReplyInfo() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      'section[data-turn="assistant"]',
      '.font-claude-message',
      '.font-claude-response',
      '[data-is-streaming]',
      'model-response',
    ];
    for (const selector of selectors) {
      const list = Array.from(document.querySelectorAll(selector)).filter(
        (el) => !el.closest('#cca-root')
      );
      if (!list.length) continue;
      const el = list[list.length - 1];
      if (!el) continue;
      return { element: el, count: list.length, source: selector };
    }
    return { element: null, count: null, source: '' };
  }

  function getLastAssistantReplyElement() {
    return getLastAssistantReplyInfo().element;
  }

  /** Snapshot da última resposta — texto e nó, para detectar respostas muito rápidas. */
  function getLastReplySnapshot() {
    const info = getLastAssistantReplyInfo();
    const reply = info.element;
    if (reply) {
      const t = (reply.innerText || '').trim();
      return {
        element: reply,
        signature: t ? `${t.length}:${t.slice(-80)}` : '',
        count: info.count,
        source: info.source,
      };
    }
    // Genérico: texto do conteúdo principal (painel fica fora do <main>).
    const main = document.querySelector('main, [role="main"]');
    if (main && !main.contains(document.getElementById('cca-root'))) {
      const t = (main.innerText || '').trim();
      return {
        element: main,
        signature: t ? `${t.length}:${t.slice(-80)}` : '',
        count: null,
        source: 'main',
      };
    }
    return { element: null, signature: '', count: null, source: '' };
  }

  // ─── Modo contagem (marcador do usuário) ─────────────────────────

  function parseMarkerStrings(raw = state.marker) {
    const unique = new Map();
    for (const part of String(raw || '').split(';')) {
      const value = part.trim();
      if (!value) continue;
      const key = value.toLocaleLowerCase();
      if (!unique.has(key)) unique.set(key, value);
    }
    return [...unique.values()];
  }

  function markerActive() {
    return parseMarkerStrings().length > 0 && state.minNew >= 1;
  }

  function countIn(text, needle) {
    if (!needle) return 0;
    let count = 0;
    let i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) {
      count += 1;
      i += needle.length;
    }
    return count;
  }

  function markerCountsIn(text, markers = parseMarkerStrings()) {
    const haystack = String(text || '').toLocaleLowerCase();
    return markers.map((marker) => ({
      marker,
      count: countIn(haystack, marker.toLocaleLowerCase()),
    }));
  }

  /**
   * Marcadores que começam com Markdown de negrito perdem os delimitadores
   * quando a resposta é renderizada ("**Item" vira <strong>Item...</strong>).
   * Conta essa forma renderizada sem reduzir o marcador a "Item" no texto
   * inteiro, o que geraria muitos falsos positivos.
   */
  function renderedBoldMarkerCount(root, marker) {
    if (!root?.querySelectorAll) return 0;
    const opener = marker.startsWith('**') ? '**' : marker.startsWith('__') ? '__' : '';
    if (!opener) return 0;

    const hasClosing = marker.length > opener.length * 2 && marker.endsWith(opener);
    const visibleText = marker
      .slice(opener.length, hasClosing ? -opener.length : undefined)
      .toLocaleLowerCase();
    if (!visibleText) return 0;

    let nodes;
    try {
      nodes = Array.from(root.querySelectorAll('strong, b'));
      if (root.matches?.('strong, b')) nodes.unshift(root);
    } catch {
      return 0;
    }

    // Evita contar duas vezes uma marcação incomum como <strong><b>Item</b></strong>.
    const unique = [...new Set(nodes)].filter(
      (node, _index, all) =>
        !all.some((parent) => parent !== node && parent.contains?.(node))
    );
    return unique.reduce((total, node) => {
      const text = String(node.innerText || node.textContent || '').toLocaleLowerCase();
      const matches = hasClosing ? text === visibleText : text.startsWith(visibleText);
      return total + (matches ? 1 : 0);
    }, 0);
  }

  function markerCountsInElement(root, markers = parseMarkerStrings()) {
    const text = root ? root.innerText || root.textContent || '' : '';
    const literal = markerCountsIn(text, markers);
    return literal.map((item) => ({
      marker: item.marker,
      count: item.count + renderedBoldMarkerCount(root, item.marker),
    }));
  }

  function countMarkerStringsIn(text, markers = parseMarkerStrings()) {
    return markerCountsIn(text, markers).reduce(
      (total, item) => total + item.count,
      0
    );
  }

  /**
   * Total de ocorrências do marcador no conteúdo da página (fora do painel).
   * Usa o <body> inteiro: em apps como o NotebookLM o chat fica fora do
   * <main>, o que zerava a contagem. O texto do próprio painel é descontado.
   */
  function countMarkerDetails() {
    const markers = parseMarkerStrings();
    if (!markers.length) return { total: 0, items: [] };
    const body = document.body;
    if (!body) return { total: 0, items: markers.map((marker) => ({ marker, count: 0 })) };
    const bodyCounts = markerCountsInElement(body, markers);
    const panel = document.getElementById('cca-root');
    const panelCounts = panel
      ? markerCountsInElement(panel, markers)
      : markers.map((marker) => ({ marker, count: 0 }));
    const items = bodyCounts.map((item, index) => ({
      marker: item.marker,
      count: Math.max(0, item.count - panelCounts[index].count),
    }));
    return {
      total: items.reduce((sum, item) => sum + item.count, 0),
      items,
    };
  }

  function countMarker() {
    return countMarkerDetails().total;
  }

  function markerKey(marker) {
    return String(marker || '').trim().toLocaleLowerCase();
  }

  function getMarkerMax(marker) {
    const key = markerKey(marker);
    if (!key) return 0;
    if (state.markerMax && Number.isFinite(state.markerMax[key])) {
      return Math.max(0, state.markerMax[key]);
    }
    if (Number.isFinite(DEFAULT_MARKER_MAX[key])) {
      return Math.max(0, DEFAULT_MARKER_MAX[key]);
    }
    return 0;
  }

  function checkMarkerMaxExceeded(details = countMarkerDetails()) {
    if (!details?.items?.length) return null;
    const exceeded = [];
    for (const item of details.items) {
      const max = getMarkerMax(item.marker);
      if (max >= 1 && item.count >= max) {
        exceeded.push({ marker: item.marker, count: item.count, max });
      }
    }
    return exceeded.length ? exceeded : null;
  }

  function formatExceededMessage(exceededList) {
    if (!Array.isArray(exceededList) || !exceededList.length) return '';
    return exceededList
      .map((item) => `<strong>${escapeHtml(item.marker)}</strong> (${item.count}/${item.max})`)
      .join(', ');
  }

  function markerCountMap(items = []) {
    return Object.fromEntries(items.map((item) => [markerKey(item.marker), item.count]));
  }

  /**
   * Confere a lista na última resposta conhecida. Quando o site não expõe uma
   * bolha de assistente reconhecível, usa as novas ocorrências do ciclo.
   */
  function responseMarkerStatus() {
    const markers = parseMarkerStrings();
    if (!markers.length) {
      return { required: false, satisfied: true, count: 0, matched: [], source: 'disabled' };
    }

    const reply = getLastAssistantReplyElement();
    if (reply) {
      const counts = markerCountsInElement(reply, markers).map((item) => item.count);
      const matched = markers.filter((_marker, index) => counts[index] > 0);
      const count = counts.length ? Math.max(...counts) : 0;
      return {
        required: true,
        satisfied: counts.some((value) => value >= state.minNew),
        count,
        matched,
        source: 'last-reply',
      };
    }

    const counts = markers.map((marker) => {
      const key = markerKey(marker);
      const baseline = state.markerBaselineCounts?.[key];
      const last = state.markerLastCounts?.[key];
      return Number.isFinite(baseline) && Number.isFinite(last)
        ? Math.max(0, last - baseline)
        : 0;
    });
    const matched = markers.filter((_marker, index) => counts[index] > 0);
    const count = counts.length ? Math.max(...counts) : 0;
    return {
      required: true,
      satisfied: counts.some((value) => value >= state.minNew),
      count,
      matched,
      source: 'page-delta',
    };
  }

  function markerRequirementStatusHtml(status = responseMarkerStatus()) {
    const expected = parseMarkerStrings()
      .map((marker) => `"${escapeHtml(marker)}"`)
      .join(' ou ');
    return (
      `Resposta concluída, mas ainda não contém ${expected}. ` +
      `Aguardando uma resposta válida sem parar a extensão… ` +
      `(<strong>${status.count}/${state.minNew}</strong>)`
    );
  }

  function resetMarkerCounters(baseline = null) {
    const details = baseline && Array.isArray(baseline.items) ? baseline : null;
    const total = details?.total ?? baseline;
    const hasBaseline = Number.isFinite(total);
    state.markerBaseline = hasBaseline ? total : null;
    state.markerLast = hasBaseline ? total : 0;
    state.markerBaselineCounts = details ? markerCountMap(details.items) : null;
    state.markerLastCounts = details ? markerCountMap(details.items) : null;
    state.markerStableTicks = 0;
    state.markerStableSince = hasBaseline ? Date.now() : 0;
  }

  function connectArmedKeepalive() {
    if (armedPort) return;
    try {
      armedPort = chrome.runtime.connect({ name: 'cca-armed' });
      armedPort.onMessage.addListener((msg) => {
        if (msg?.type !== 'cca-tick') return;
        runHeartbeat(msg.now);
      });
      armedPort.onDisconnect.addListener(() => {
        armedPort = null;
        if (!state.armed && !state.deletingNotebooks) return;
        // SW reiniciou — reconecta no mesmo ciclo de tarefas. Um setTimeout
        // aqui também seria throttled justamente quando a aba está oculta.
        if (armedPortReconnectQueued) return;
        armedPortReconnectQueued = true;
        queueMicrotask(() => {
          armedPortReconnectQueued = false;
          if (state.armed || state.deletingNotebooks) connectArmedKeepalive();
        });
      });
      dlog('keepalive: conectado ao service worker');
    } catch (err) {
      dlog('keepalive: falha ao conectar', err);
      armedPort = null;
    }
  }

  function disconnectArmedKeepalive() {
    // Mantém a porta se ainda houver limpeza ou execução automática ativa.
    if (state.armed || state.deletingNotebooks) return;
    armedPortReconnectQueued = false;
    if (!armedPort) return;
    try {
      armedPort.disconnect();
    } catch {
      // ignore
    }
    armedPort = null;
  }

  /** Texto de parada ativo (não vazio). */
  function stopTextActive() {
    return !!(state.stopText && state.stopText.trim());
  }

  /**
   * Total de ocorrências do texto de parada no conteúdo da página
   * (fora do painel da extensão).
   */
  function countStopText() {
    const needle = state.stopText;
    if (!needle || !needle.trim()) return 0;
    const body = document.body;
    if (!body) return 0;
    let count = countIn(body.innerText || '', needle);
    const panel = document.getElementById('cca-root');
    if (panel) {
      count -= countIn(panel.innerText || '', needle);
    }
    return Math.max(0, count);
  }

  /**
   * Depois que o fim da resposta foi confirmado, verifica se o texto de parada
   * surgiu desde o Iniciar e está na última resposta conhecida da IA. Encerra
   * as inserções e retorna true somente nesse momento.
   */
  function checkStopTextAndHaltAfterGeneration() {
    if (!stopTextActive() || !state.armed) return false;

    // Defesa adicional: esta função só deve ser chamada após o fim confirmado.
    if (isGenerating()) return false;

    const current = countStopText();
    if (state.stopTextBaseline === null) {
      state.stopTextBaseline = current;
      return false;
    }
    if (current <= state.stopTextBaseline) return false;

    // Evita aceitar texto de botões, prompts ou outras áreas da página. Em uma
    // interface sem seletor conhecido, mantém a contagem da conversa como
    // fallback para não quebrar os sites já suportados.
    const reply = getLastAssistantReplyElement();
    if (reply && !countIn(reply.innerText || '', state.stopText)) return false;

    dlog('texto de parada detectado', {
      text: state.stopText,
      baseline: state.stopTextBaseline,
      current,
      source: reply ? 'última resposta da IA' : 'conversa (fallback)',
    });
    stop();
    setStatus(
      `🛑 <strong>Resposta concluída com o texto de parada</strong>: ` +
        `"${escapeHtml(state.stopText)}". Inserções encerradas.`
    );
    setFinishedTabVisual(`Texto de parada: "${state.stopText}"`);
    return true;
  }

  function findComposer() {
    const preferred = [
      // ChatGPT
      '#prompt-textarea',
      'div#prompt-textarea[contenteditable="true"]',
      'div[contenteditable="true"]#prompt-textarea',
      'div.ProseMirror#prompt-textarea',
      'div[contenteditable="true"][data-id="root"]',
      // Claude
      'div.ProseMirror[contenteditable="true"]',
      'fieldset div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][aria-label*="Write" i]',
      'div[contenteditable="true"][aria-label*="Reply" i]',
      // Gemini
      'rich-textarea .ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      // Genéricos
      'div[contenteditable="true"][role="textbox"]',
      'textarea[name="prompt-textarea"]',
      'textarea[data-id="root"]',
      'form textarea',
    ];

    for (const sel of preferred) {
      // #prompt-textarea às vezes tem height 0 no wrapper — aceita sem visible estrito
      const loose = sel.includes('prompt-textarea');
      const els = queryAll(sel, { requireVisible: !loose });
      const sorted = els
        .filter((el) => !el.closest('#cca-root'))
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      if (sorted[0]) {
        // Se pegou um wrapper, desce para o contenteditable interno
        const el = sorted[0];
        if (!el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
          const inner =
            el.querySelector('[contenteditable="true"]') ||
            el.querySelector('textarea');
          if (inner && !inner.closest('#cca-root')) return inner;
        }
        return el;
      }
    }

    // Último recurso: contenteditable mais baixo da página
    const all = queryAll('div[contenteditable="true"], textarea')
      .filter((el) => !el.closest('#cca-root'))
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return all[0] || null;
  }

  function findSendButton(composerHint = null) {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[aria-label="Enviar mensagem"]',
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Enviar" i]',
      'button[aria-label="Submit"]',
      'button[type="submit"][aria-label*="submit" i]',
      'button[title*="send" i]',
      'button[title*="enviar" i]',
    ];
    const identifiedAsSend = (button) => {
      const identity = [
        button.getAttribute('data-testid'),
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('name'),
        button.getAttribute('data-action'),
        button.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      if (
        /stop|parar|cancel|cancelar|interromper|voice|voz|audio|microphone|microfone|attach|anexar|upload|feedback/.test(
          identity
        )
      ) {
        return false;
      }
      return /send|enviar|submit|mandar/.test(identity);
    };
    const usable = (button) =>
      !!button &&
      !button.closest('#cca-root') &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      identifiedAsSend(button) &&
      visible(button);

    // Primeiro limita a busca ao formulário do composer que acabou de receber
    // o texto, evitando clicar no botão de outro formulário da SPA.
    const hintedForm = composerHint?.closest?.('form');
    if (hintedForm) {
      for (const sel of selectors) {
        const local = Array.from(hintedForm.querySelectorAll(sel)).find(usable);
        if (local) return local;
      }
      const localSend = Array.from(hintedForm.querySelectorAll('button')).find(usable);
      if (localSend) return localSend;
      return null;
    }

    for (const sel of selectors) {
      const el = queryAll(sel).find(usable);
      if (el) return el;
    }
    // Alguns sites expõem o identificador fora dos seletores conhecidos.
    const composer = composerHint || findComposer();
    if (composer) {
      const form = composer.closest('form');
      if (form) {
        const sendLike = Array.from(form.querySelectorAll('button')).find(usable);
        if (sendLike) return sendLike;
      }
    }
    return null;
  }

  function getComposerPlainText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function composerHasText(el, text) {
    const got = getComposerPlainText(el).replace(/\s+/g, ' ').trim();
    const want = text.replace(/\s+/g, ' ').trim();
    if (!want) return got.length > 0;
    return got.includes(want.slice(0, Math.min(24, want.length)));
  }

  /** Contagem da página sem o rascunho atual do contenteditable. */
  function markerCountOutsideComposer(composer) {
    if (!markerActive()) return null;
    const current = countMarkerDetails();
    if (!composer || composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      return current;
    }
    const draftCounts = markerCountMap(markerCountsIn(getComposerPlainText(composer)));
    const items = current.items.map((item) => ({
      marker: item.marker,
      count: Math.max(0, item.count - (draftCounts[markerKey(item.marker)] || 0)),
    }));
    return {
      total: items.reduce((sum, item) => sum + item.count, 0),
      items,
    };
  }

  function insertViaPasteEvent(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    let evt;
    try {
      evt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
    } catch {
      evt = new Event('paste', { bubbles: true, cancelable: true });
    }
    try {
      Object.defineProperty(evt, 'clipboardData', { value: dt, configurable: true });
    } catch {
      // ignore
    }
    return el.dispatchEvent(evt);
  }

  function insertViaExecCommand(el, text) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
    );
  }

  function insertViaBeforeInput(el, text) {
    el.focus();
    el.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      })
    );
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      })
    );
  }

  function setNativeValue(el, text) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setComposerText(el, text) {
    if (!el) return false;

    // Garante foco (ProseMirror/Lexical só aceitam com seleção ativa).
    try {
      el.click();
    } catch {
      // ignore
    }
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, text);
      return composerHasText(el, text);
    }

    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // 1) execCommand insertText (melhor para ProseMirror)
      try {
        insertViaExecCommand(el, text);
      } catch {
        // ignore
      }
      if (composerHasText(el, text)) return true;

      // 2) evento paste sintético
      try {
        // limpa e tenta de novo
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        insertViaPasteEvent(el, text);
      } catch {
        // ignore
      }
      if (composerHasText(el, text)) return true;

      // 3) beforeinput
      try {
        insertViaBeforeInput(el, text);
      } catch {
        // ignore
      }
      if (composerHasText(el, text)) return true;

      // 4) último recurso visual (pode não habilitar o Send no React)
      el.focus();
      el.textContent = text;
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        })
      );
      return composerHasText(el, text);
    }

    return false;
  }

  function pressEnter(el) {
    if (!el) return;
    const opts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function composerSubmissionObserved(composer, text, hardStreamingBeforeSubmit = false) {
    return (
      !composer ||
      composer.isConnected === false ||
      !composerHasText(composer, text) ||
      (!hardStreamingBeforeSubmit && hasHardStreamingSignal())
    );
  }

  /**
   * Popup "Parar de gerar?" (NotebookLM/Gemini): ao enviar texto enquanto a IA
   * ainda gera, o site pergunta se deve interromper. Clica em "Continuar gerando".
   * Só age com a extensão armada — parada, deixa o modal intacto.
   */
  function dismissStopGeneratingDialog() {
    if (!state.armed) return false;
    const dialogs = Array.from(
      document.querySelectorAll(
        'mat-dialog-container, [role="dialog"], .mat-mdc-dialog-container, .cdk-overlay-pane'
      )
    );
    for (const dlg of dialogs) {
      if (dlg.closest?.('#cca-root')) continue;
      const text = (dlg.innerText || dlg.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      if (
        !/parar de gerar|stop generating|interromper a resposta|interrupt (the )?response|removê-la da conversa|remove it from the conversation/.test(
          lower
        )
      ) {
        continue;
      }

      const btns = Array.from(dlg.querySelectorAll('button, [role="button"]'));
      const continueBtn = btns.find((b) => {
        const t = (b.innerText || b.textContent || b.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        return (
          /continuar gerando|continue generating|keep generating|continuar|keep going/.test(t) &&
          !/parar$|^stop$|interromper/.test(t)
        );
      });
      if (!continueBtn) continue;

      dlog('popup "Parar de gerar?" — clicando Continuar gerando');
      try {
        continueBtn.click();
      } catch {
        try {
          continueBtn.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
          );
        } catch {
          // ignore
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Registra o estado imediatamente antes do clique/Enter. A resposta nova
   * ainda não pode ter começado, portanto este é o limite correto do ciclo.
   */
  function createWatchSnapshot(text, markerCountBeforeInsert) {
    const reply = getLastReplySnapshot();
    let markerBaseline = null;
    if (markerActive()) {
      const outside =
        markerCountBeforeInsert && Array.isArray(markerCountBeforeInsert.items)
          ? markerCountBeforeInsert
          : countMarkerDetails();
      const outgoing = markerCountMap(markerCountsIn(text));
      const items = outside.items.map((item) => ({
        marker: item.marker,
        count: item.count + (outgoing[markerKey(item.marker)] || 0),
      }));
      // A base exclui o rascunho antigo e inclui o prompt exatamente uma vez.
      markerBaseline = {
        total: items.reduce((sum, item) => sum + item.count, 0),
        items,
      };
    }
    return {
      replyElement: reply.element,
      replySignature: reply.signature,
      replyCount: reply.count,
      replySource: reply.source,
      markerBaseline,
    };
  }

  async function sendMessage(text) {
    try {
      dismissStopGeneratingDialog();

      let composer = null;
      let markerCountBeforeInsert = null;
      let ok = false;
      for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
        dismissStopGeneratingDialog();
        // SPAs costumam substituir o composer ao finalizar uma resposta. Busca
        // novamente em cada tentativa para não escrever em um nó desconectado.
        composer = findComposer();
        if (composer && composer.isConnected !== false) {
          markerCountBeforeInsert = markerCountOutsideComposer(composer);
          dlog('sendMessage: composer =', composer.id || composer.className || composer.tagName, {
            attempt: attempt + 1,
            hidden: pageLikelyBackgrounded(),
          });
          setStatus(`Campo achado (<code>${composer.id || composer.tagName}</code>). Inserindo…`);
          ok = setComposerText(composer, text);
          if (ok) break;
        }
        dlog('sendMessage: composer ausente/desconectado ou inserção falhou, retry', attempt + 1);
        await sleep(250 + attempt * 200);
      }
      if (!ok || !composer) {
        dlog('sendMessage: inserção FALHOU no composer após retries');
        setStatus(
          pageLikelyBackgrounded()
            ? 'Aba em segundo plano bloqueou a inserção. Mantendo ativo — tentando de novo…'
            : 'Não consegui inserir no campo do chat. Mantendo ativo — tentando de novo…'
        );
        return false;
      }

      await sleep(BEFORE_SEND_MS);
      dismissStopGeneratingDialog();

      // Sempre confirma o composer imediatamente antes do envio. Algumas SPAs
      // mantêm o nó antigo conectado enquanto já exibem um novo campo.
      const freshComposer = findComposer();
      if (
        !freshComposer ||
        freshComposer !== composer ||
        composer.isConnected === false ||
        !composerHasText(composer, text)
      ) {
        const freshMarkerCountBeforeInsert = markerCountOutsideComposer(freshComposer);
        if (!freshComposer || !setComposerText(freshComposer, text)) {
          dlog('sendMessage: composer foi substituído antes do envio');
          return false;
        }
        composer = freshComposer;
        markerCountBeforeInsert = freshMarkerCountBeforeInsert;
        await sleep(100);
      }

      const watchSnapshot = createWatchSnapshot(text, markerCountBeforeInsert);
      const hardStreamingBeforeSubmit = hasHardStreamingSignal();
      const sendBtn = findSendButton(composer);
      dlog('sendMessage: inserido OK; sendBtn =', sendBtn ? 'achado' : 'não achado');
      if (sendBtn) {
        sendBtn.click();
        await sleep(250);
        // Continuar gerando = o site bloqueou nosso envio para não interromper a IA.
        if (dismissStopGeneratingDialog()) {
          dlog('sendMessage: popup Continuar gerando — envio NÃO concluído');
          await sleep(200);
          dismissStopGeneratingDialog();
          return false;
        }
        await sleep(350);
        if (dismissStopGeneratingDialog()) {
          dlog('sendMessage: popup Continuar gerando (tardio) — envio NÃO concluído');
          return false;
        }
        if (!composerSubmissionObserved(composer, text, hardStreamingBeforeSubmit)) {
          dlog('sendMessage: clique não produziu evidência de envio');
          setStatus('O botão foi acionado, mas o chat não confirmou o envio. Tentando de novo…');
          return false;
        }
        state.lastSendAt = Date.now();
        return watchSnapshot;
      }

      pressEnter(composer);
      await sleep(250);
      if (dismissStopGeneratingDialog()) {
        dlog('sendMessage: popup Continuar gerando após Enter — envio NÃO concluído');
        return false;
      }
      if (composerSubmissionObserved(composer, text, hardStreamingBeforeSubmit)) {
        state.lastSendAt = Date.now();
        return watchSnapshot;
      }

      // Enter não foi consumido: tenta apenas um botão inequivocamente de envio.
      const retry = findSendButton(composer);
      if (retry) {
        retry.click();
        await sleep(250);
        if (dismissStopGeneratingDialog()) {
          dlog('sendMessage: popup Continuar gerando no retry — envio NÃO concluído');
          return false;
        }
        if (!composerSubmissionObserved(composer, text, hardStreamingBeforeSubmit)) {
          dlog('sendMessage: retry do botão não produziu evidência de envio');
          return false;
        }
        state.lastSendAt = Date.now();
        return watchSnapshot;
      }

      if (!composerSubmissionObserved(composer, text, hardStreamingBeforeSubmit)) {
        dlog('sendMessage: Enter não enviou e o texto permaneceu no composer');
        setStatus('O texto entrou no campo, mas o Enter não enviou. Tentando de novo…');
        return false;
      }
      state.lastSendAt = Date.now();
      dismissStopGeneratingDialog();
      return watchSnapshot;
    } catch (err) {
      dlog('sendMessage erro', err);
      return false;
    }
  }

  function sleep(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => {
      const waiter = {
        deadline: Date.now() + delay,
        timer: null,
        resolve: null,
      };
      waiter.resolve = () => {
        if (!pendingSleeps.delete(waiter)) return;
        if (waiter.timer != null) clearTimeout(waiter.timer);
        resolve();
      };
      pendingSleeps.add(waiter);
      // Caminho normal com a aba visível. Em segundo plano, runHeartbeat()
      // libera o mesmo waiter pelo relógio de parede, sem depender deste timer.
      waiter.timer = setTimeout(waiter.resolve, delay);
    });
  }

  function flushDueSleeps(now = Date.now()) {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    for (const waiter of Array.from(pendingSleeps)) {
      if (timestamp >= waiter.deadline) waiter.resolve();
    }
  }

  function runHeartbeat(now = Date.now()) {
    // Resolve primeiro os awaits internos que estariam throttled na aba oculta.
    // A continuação roda como microtask depois deste handler; o tick atual ainda
    // respeita pendingSend e o próximo pulso observa o novo estado.
    flushDueSleeps(now);
    try {
      // Reconecta keepalive se a porta caiu (SW MV3 reiniciou / aba em background).
      if ((state.armed || state.deletingNotebooks) && !armedPort) {
        connectArmedKeepalive();
      }

      // pendingSend preso (ex.: exceção no meio do envio) → libera o ciclo.
      if (
        state.pendingSend &&
        state.pendingSendSince > 0 &&
        now - state.pendingSendSince > PENDING_SEND_TIMEOUT_MS
      ) {
        dlog('watchdog: pendingSend preso — liberando', {
          sinceMs: now - state.pendingSendSince,
        });
        state.pendingSend = false;
        state.pendingSendSince = 0;
        if (state.armed && state.phase === 'idle') {
          state.phase = 'watch';
          state.sawStreaming = true;
        }
        setStatus('Recuperando de envio preso… continuando.');
      }

      // Mesmo com pendingSend: o popup "Parar de gerar?" aparece ao enviar.
      // Só com a extensão ativa — parada, não interferir no modal.
      if (state.armed) dismissStopGeneratingDialog();
      tick();

      // Sem progresso por muito tempo com a IA parada → força novo ciclo de envio.
      if (
        state.armed &&
        !state.pendingSend &&
        !state.finishing &&
        state.phase !== 'idle' &&
        state.remaining > 0
      ) {
        const sinceSend = now - (state.lastSendAt || 0);
        const sinceNudge = now - (state.lastStuckNudgeAt || 0);
        if (sinceSend >= STUCK_WATCH_MS && sinceNudge >= 30000 && !isGenerating()) {
          const markerStatus = responseMarkerStatus();
          if (markerStatus.required && !markerStatus.satisfied) {
            state.lastStuckNudgeAt = now;
            setStatus(markerRequirementStatusHtml(markerStatus));
            dlog('watchdog: aguardando string aceita; não forçando envio', markerStatus);
            return;
          }
          dlog('watchdog: sem progresso — forçando ciclo', { sinceSend });
          state.lastStuckNudgeAt = now;
          state.sawStreaming = true;
          state.phase = 'streaming';
          state.stableTicks = 99;
          state.replyStableSince = now - 5000;
          state.markerStableTicks = 99;
          if (!state.markerStableSince) state.markerStableSince = now - STABLE_MS;
          void onGenerationEnded('watchdog sem progresso');
        }
      }
    } catch (err) {
      dlog('heartbeat erro', err);
    }
  }

  // ─── Máquina de estados ──────────────────────────────────────────

  function armWatchAfterSend(snapshot = null) {
    state.phase = 'watch';
    state.sawStreaming = false;
    state.stableTicks = 0;
    state.replyStableSince = 0;
    const fallbackReply = snapshot ? null : getLastReplySnapshot();
    state.lastReplySig = snapshot?.replySignature ?? fallbackReply?.signature ?? '';
    state.lastReplyEl = snapshot ? snapshot.replyElement : fallbackReply?.element || null;
    state.lastReplyCount = snapshot ? snapshot.replyCount : fallbackReply?.count ?? null;
    state.lastReplySource = snapshot ? snapshot.replySource : fallbackReply?.source || '';
    state.sawHardStreaming = false;
    // Usa a fotografia anterior ao clique. Assim, nenhuma parte da resposta
    // nova — ainda que o marcador apareça logo no início — entra na baseline.
    resetMarkerCounters(snapshot?.markerBaseline);
    dlog('monitor armado após envio', {
      markerBaseline: state.markerBaseline,
      replySignature: state.lastReplySig,
    });
  }

  function replyAdvancedSince(previous) {
    const current = getLastReplySnapshot();
    const countAdvanced =
      current.source === previous.source &&
      Number.isFinite(current.count) &&
      Number.isFinite(previous.count) &&
      current.count > previous.count;
    return {
      current,
      advanced: countAdvanced || current.signature !== previous.signature,
    };
  }

  function resumeWatchingReply(reply, status) {
    state.lastReplyEl = reply.element;
    state.lastReplySig = reply.signature;
    state.lastReplyCount = reply.count;
    state.lastReplySource = reply.source;
    state.stableTicks = 0;
    state.replyStableSince = 0;
    state.phase = 'streaming';
    state.sawStreaming = true;
    setStatus(status);
  }

  async function onGenerationEnded(reason) {
    if (!state.armed || state.pendingSend) return;
    if (state.phase === 'idle') return;

    // Evita reagir imediatamente após o nosso próprio send
    if (Date.now() - state.lastSendAt < 2500) return;
    // Backoff após falha de inserção (comum com aba/minimizado em segundo plano)
    if (Date.now() - state.lastSendAttemptAt < SEND_RETRY_MS) return;
    const endCandidateReply = getLastReplySnapshot();

    // Modo finalização: a última inserção já foi enviada. Ao detectar que a IA
    // terminou de responder a ela, encerra (para timer/contagens) sem reenviar.
    if (state.finishing) {
      dlog('onGenerationEnded (finalizando):', reason, '— confirmando fim');
      state.pendingSend = true;
      state.pendingSendSince = Date.now();
      state.phase = 'idle';
      setStatus(`IA finalizando a última resposta (${reason})… confirmando.`);

      try {
        await sleep(AFTER_IDLE_MS);

        if (!state.armed) return;
        if (isGenerating()) {
          state.phase = 'streaming';
          state.sawStreaming = true;
          setStatus('Geração retomou — aguardando parar de novo.');
          return;
        }
        const finalReplyCheck = replyAdvancedSince(endCandidateReply);
        if (finalReplyCheck.advanced) {
          resumeWatchingReply(
            finalReplyCheck.current,
            'A resposta voltou a mudar — aguardando estabilizar novamente.'
          );
          return;
        }
        if (markerActive() && state.markerBaseline !== null) {
          const c = countMarker();
          if (c > state.markerLast) {
            state.markerLast = c;
            state.markerStableTicks = 0;
            state.markerStableSince = 0;
            state.phase = 'streaming';
            state.sawStreaming = true;
            setStatus('Novas ocorrências surgiram — aguardando estabilizar.');
            return;
          }
        }
        if (checkStopTextAndHaltAfterGeneration()) return;
        const finalMarkerStatus = responseMarkerStatus();
        if (finalMarkerStatus.required && !finalMarkerStatus.satisfied) {
          state.phase = 'streaming';
          state.sawStreaming = true;
          setStatus(markerRequirementStatusHtml(finalMarkerStatus));
          return;
        }
        finishRun(reason);
      } finally {
        state.pendingSend = false;
        state.pendingSendSince = 0;
      }
      return;
    }

    if (state.remaining <= 0) return;

    dlog('onGenerationEnded:', reason, '— enviando após delay');
    state.pendingSend = true;
    state.pendingSendSince = Date.now();
    state.phase = 'idle'; // trava reentrância até o próximo send
    setStatus(
      `IA parou (${reason}). Enviando em ${AFTER_IDLE_MS / 1000}s… (${restHtml()})`
    );

    try {
      await sleep(AFTER_IDLE_MS);

      if (!state.armed || state.remaining <= 0) return;

      if (isGenerating()) {
        state.phase = 'streaming';
        state.sawStreaming = true;
        setStatus('Geração retomou — aguardando parar de novo.');
        return;
      }
      const replyCheck = replyAdvancedSince(endCandidateReply);
      if (replyCheck.advanced) {
        resumeWatchingReply(
          replyCheck.current,
          'A resposta voltou a mudar — aguardando estabilizar novamente.'
        );
        return;
      }

      if (markerActive() && state.markerBaseline !== null) {
        const exceeded = checkMarkerMaxExceeded();
        if (exceeded) {
          dlog('marcador: máximo atingido antes do envio', exceeded);
          stop();
          setStatus(
            `⚠️ <strong>Limite máximo atingido</strong>: ${formatExceededMessage(exceeded)} ` +
              `ocorrências na página. Execução parada.`
          );
          setFinishedTabVisual('Limite de ocorrências atingido');
          return;
        }
        const c = countMarker();
        if (c > state.markerLast) {
          state.markerLast = c;
          state.markerStableTicks = 0;
          state.markerStableSince = 0;
          state.phase = 'streaming';
          state.sawStreaming = true;
          setStatus('Novas ocorrências surgiram durante a espera — aguardando estabilizar.');
          return;
        }
      }

      if (checkStopTextAndHaltAfterGeneration()) return;
      const markerStatus = responseMarkerStatus();
      if (markerStatus.required && !markerStatus.satisfied) {
        state.phase = 'streaming';
        state.sawStreaming = true;
        setStatus(markerRequirementStatusHtml(markerStatus));
        return;
      }

      const text = state.text;
      state.lastSendAttemptAt = Date.now();
      const sendResult = await sendMessage(text);
      if (sendResult) {
        state.remaining -= 1;
        persistUiFields();
        if (state.remaining <= 0) {
          state.finishing = true;
          armWatchAfterSend(sendResult);
          setStatus('Última inserção enviada. Aguardando a IA terminar a resposta…');
        } else {
          armWatchAfterSend(sendResult);
          setStatus(`Enviado. Aguardando próxima resposta… (${restHtml()})`);
        }
      } else {
        dlog('onGenerationEnded: envio falhou — reagendando (background?)', {
          hidden: pageLikelyBackgrounded(),
        });
        state.retrySend = true;
        state.phase = 'watch';
        state.sawStreaming = true;
        state.markerStableTicks = 0;
        if (state.markerStableSince) state.markerStableSince = Date.now();
        state.replyStableSince = 0;
        state.stableTicks = 0;
        setStatus(
          pageLikelyBackgrounded()
            ? `Falha ao enviar (navegador em segundo plano). Continuando a tentar… (${restHtml()})`
            : `IA ainda gerando ou envio bloqueado. Aguardando e tentando de novo… (${restHtml()})`
        );
      }
    } catch (err) {
      dlog('onGenerationEnded erro', err);
      state.retrySend = true;
      state.phase = 'watch';
      state.sawStreaming = true;
    } finally {
      state.pendingSend = false;
      state.pendingSendSince = 0;
      updateFab();
    }
  }

  /** Atualiza contagem, atividade e limite das strings aceitas. */
  function markerTick(elapsed) {
    const currentDetails = countMarkerDetails();
    const current = currentDetails.total;

    // Limite máximo individual por string na página: ao atingir qualquer um, para tudo com aviso.
    const exceeded = checkMarkerMaxExceeded(currentDetails);
    if (exceeded) {
      dlog('marcador: máximo atingido', exceeded);
      stop();
      setStatus(
        `⚠️ <strong>Limite máximo atingido</strong>: ${formatExceededMessage(exceeded)} ` +
          `ocorrências na página. Execução parada.`
      );
      setFinishedTabVisual('Limite de ocorrências atingido');
      return true;
    }

    // Fallback para ciclos antigos/sem snapshot. Nos envios normais a baseline
    // já vem da fotografia feita antes do clique no botão Enviar.
    if (state.markerBaseline === null) {
      resetMarkerCounters(currentDetails);
      dlog('marcador: baseline de fallback =', current, { elapsed });
      return false;
    }

    let markerGrew = false;
    state.markerBaselineCounts ||= {};
    state.markerLastCounts ||= {};
    for (const item of currentDetails.items) {
      const key = markerKey(item.marker);
      if (!Number.isFinite(state.markerBaselineCounts[key])) {
        state.markerBaselineCounts[key] = item.count;
        state.markerLastCounts[key] = item.count;
        continue;
      }
      const previous = state.markerLastCounts[key] ?? state.markerBaselineCounts[key];
      if (item.count > previous) {
        state.markerLastCounts[key] = item.count;
        markerGrew = true;
      }
    }

    if (markerGrew) {
      state.markerLast = Math.max(state.markerLast, current);
      state.markerStableTicks = 0;
      state.markerStableSince = 0;
      state.sawStreaming = true;
      state.phase = 'streaming';
    } else {
      state.markerStableTicks += 1;
      if (!state.markerStableSince) state.markerStableSince = Date.now();
    }
    return false;
  }

  function tick() {
    updateCountLine();
    updateTimerLine();

    if (!state.armed || state.pendingSend) return;
    if (!state.finishing && state.remaining <= 0) return;
    if (state.phase === 'idle') return;

    const elapsed = Date.now() - state.lastSendAt;

    // Se a tentativa anterior não chegou a ser enviada, repete diretamente.
    // Não exige strings da resposta anterior, pois ainda não existe um novo ciclo.
    if (state.retrySend) {
      if (isGenerating()) {
        setStatus(`A tentativa anterior falhou; aguardando a IA parar antes de repetir… (${restHtml()})`);
        return;
      }
      if (Date.now() - state.lastSendAttemptAt < SEND_RETRY_MS) {
        setStatus(`Falha ao inserir/enviar. Nova tentativa automática em instantes… (${restHtml()})`);
        return;
      }
      state.retrySend = false;
      state.phase = 'idle';
      void sendFirstNow(state.remaining);
      return;
    }

    if (markerActive() && markerTick(elapsed)) return;

    // Estabilidade do texto ANTES de isGenerating(): ela destrava sinais
    // fracos presos (blocos de thinking de respostas já concluídas).
    if (elapsed >= 1500) {
      const reply = getLastReplySnapshot();
      const sig = reply.signature;
      const sameSource = reply.source === state.lastReplySource;
      const newReplyTurn =
        sameSource &&
        Number.isFinite(reply.count) &&
        Number.isFinite(state.lastReplyCount) &&
        reply.count > state.lastReplyCount;
      const textChanged = !!sig && sig !== state.lastReplySig;
      if (sig && sig === state.lastReplySig && !newReplyTurn) {
        // Rerender do mesmo turno: atualiza o nó sem fingir que uma nova
        // resposta começou.
        state.lastReplyEl = reply.element;
        state.lastReplyCount = reply.count;
        state.lastReplySource = reply.source;
        state.stableTicks += 1;
        if (!state.replyStableSince) state.replyStableSince = Date.now();
      } else {
        state.lastReplyEl = reply.element;
        state.lastReplySig = sig;
        state.lastReplyCount = reply.count;
        state.lastReplySource = reply.source;
        state.stableTicks = 0;
        state.replyStableSince = 0;
        if (textChanged || newReplyTurn) {
          state.sawStreaming = true;
          state.phase = 'streaming';
        }
      }
    }

    const hardGenerating = hasHardStreamingSignal();
    const gen = hardGenerating || isGenerating();

    if (gen) {
      state.sawStreaming = true;
      if (hardGenerating) state.sawHardStreaming = true;
      state.phase = 'streaming';
      setStatus(`IA gerando… (${restHtml()})`);
      return;
    }

    const sendReady = isSendButtonReady();
    const stableEnough = replyStableFor(2000) || state.stableTicks >= 5;
    const finishedByStop =
      state.sawHardStreaming && state.phase === 'streaming' && !gen && elapsed >= 2500;
    // Não exige sendReady: ChatGPT com composer vazio mostra o botão de voz,
    // então o send-button não existe mesmo com a IA parada.
    const finishedByStable = state.sawStreaming && stableEnough && elapsed >= 4000;
    const finishedBySendBack =
      state.sawStreaming &&
      sendReady &&
      elapsed >= 3000 &&
      !gen &&
      state.phase === 'streaming' &&
      (state.sawHardStreaming || stableEnough);

    const finishReason = finishedByStop
      ? 'stop sumiu'
      : finishedBySendBack
        ? 'send voltou'
        : finishedByStable
          ? 'texto estável'
          : '';

    if (finishReason) {
      // O texto de parada tem precedência sobre a lista de respostas aceitas.
      if (checkStopTextAndHaltAfterGeneration()) return;
      const markerStatus = responseMarkerStatus();
      if (markerStatus.required && !markerStatus.satisfied) {
        dlog('fim detectado, aguardando string aceita', {
          reason: finishReason,
          count: markerStatus.count,
          source: markerStatus.source,
        });
        setStatus(markerRequirementStatusHtml(markerStatus));
        return;
      }
      dlog('fim detectado:', finishReason, {
        elapsed,
        stableTicks: state.stableTicks,
        stableMs: state.replyStableSince ? Date.now() - state.replyStableSince : 0,
        matchedMarkers: markerStatus.matched,
      });
      void onGenerationEnded(finishReason);
      return;
    }

    if (state.phase === 'watch') {
      setStatus(
        `Aguardando a IA gerar/terminar… (${restHtml()})` +
          (state.sawStreaming ? ' · stream visto' : '')
      );
    } else if (state.phase === 'streaming' && !gen) {
      setStatus(
        `Confirmando fim da resposta… (${state.stableTicks}/5) · ${restHtml()}`
      );
    }
  }

  // ─── NotebookLM: exclusão de notebooks não fixados ───────────────

  /** Parseia textos protetores (separados por vírgula), sem vazios. */
  function parseProtectTitles(raw) {
    const src = typeof raw === 'string' ? raw : state.protectTitles;
    return src
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function notebookTitle(card) {
    if (!card) return '';
    const el = card.querySelector(
      '.project-button-title, [class*="project-button-title"], [class*="project-title" i], [class*="notebook-title" i], h3, h2, [class*="title" i]'
    );
    const text = el?.textContent || card.getAttribute('aria-label') || card.getAttribute('title') || '';
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Retorna true APENAS se o texto/atributo indicar explicitamente que o item
   * JÁ ESTÁ fixado (ex.: "Fixado", "Pinned", "Desafixar", "Unpin").
   * Retorna false se indicar ação de fixar (ex.: "Fixar", "Pin to top") ou "Não fixado".
   */
  function textOrAttrIsPinned(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim().toLowerCase();
    if (!s) return false;

    // Se disser expressamente "não fixado" ou "unpinned" ou ação de "fixar / pin"
    if (/não fixad|not pinned|unpinned/.test(s)) return false;
    if (/^(fixar|pin|fijar|épingler|anpinnen)(\s+na\s+parte\s+superior|\s+to\s+top)?$/.test(s)) {
      return false; // Ação de fixar = o notebook atualmente NÃO está fixado
    }

    // Termos que indicam que o notebook JÁ ESTÁ fixado:
    return /\bfixad[ao]s?\b|desafix|pinned|unpin|push_pin|pushpin|thumbtack|keep_pin|desfij|désépingl|loslös/.test(
      s
    );
  }

  /**
   * Verifica se um elemento ou ícone corresponde a um alfinete/pin.
   */
  function iconLooksLikePin(el) {
    if (!el) return false;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (
      /^(push_pin|keep|keep_pin|pin|pushpin|thumbtack|bookmark|push_pin_filled|keep_public)$/i.test(
        text
      )
    ) {
      return true;
    }
    const fontIcon = (
      el.getAttribute('fonticon') ||
      el.getAttribute('data-mat-icon-name') ||
      ''
    ).toLowerCase();
    if (/push_pin|keep|pin|pushpin|thumbtack/.test(fontIcon)) {
      return true;
    }
    return false;
  }

  /**
   * Verifica se o card possui elementos visuais, classes ou atributos que provam que está fixado.
   */
  function cardHasPinIndicators(card) {
    if (!card) return false;
    if (card.dataset.ccaIsPinned === '1' || card.dataset.ccaPinned === '1') return true;

    // 1. Classes e atributos de estado fixado no próprio card
    if (
      card.matches(
        '.pinned, .is-pinned, .project-pinned, [data-pinned="true"], [data-is-pinned="true"], [aria-pinned="true"]'
      )
    ) {
      return true;
    }

    // 2. Classes explícitas de pin ativo em elementos descendentes
    if (
      card.querySelector(
        '.project-action-pin-icon, .pinned-icon, [class*="pinned-icon" i]'
      )
    ) {
      return true;
    }

    // 3. Atributos em elementos no card (aria-label, title, mattooltip, etc.)
    const candidates = [card, ...card.querySelectorAll('*')];
    for (const el of candidates) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const tooltip = el.getAttribute('mattooltip') || el.getAttribute('data-tooltip') || '';
      const ariaDesc = el.getAttribute('aria-description') || '';
      if (
        textOrAttrIsPinned(ariaLabel) ||
        textOrAttrIsPinned(title) ||
        textOrAttrIsPinned(tooltip) ||
        textOrAttrIsPinned(ariaDesc)
      ) {
        return true;
      }
    }

    // 4. Ícones estáticos ou botões de pin
    const icons = Array.from(
      card.querySelectorAll(
        'mat-icon, .material-symbols-outlined, .material-icons, .material-icons-outlined, i, svg, [role="img"]'
      )
    );
    for (const icon of icons) {
      if (iconLooksLikePin(icon)) {
        const parentBtn = icon.closest('button');
        if (parentBtn) {
          const btnText = (
            (parentBtn.getAttribute('aria-label') || '') +
            ' ' +
            (parentBtn.getAttribute('title') || '') +
            ' ' +
            (parentBtn.textContent || '')
          ).toLowerCase();
          if (/desafix|unpin|desfij|désépingl|loslös/.test(btnText)) {
            return true;
          }
          if (/^(fixar|pin|fijar|épingler|anpinnen)/.test(btnText.trim())) {
            // Botão para fixar -> card não fixado
            continue;
          }
        }
        // Ícone estático no card
        return true;
      }
    }

    return false;
  }

  /**
   * Verifica se o card está localizado dentro da seção de notebooks fixados.
   */
  function isCardInPinnedSection(card) {
    if (!card) return false;

    // 1. Ancestrais de contêiner específicos de itens fixados
    let parent = card.parentElement;
    while (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      !parent.matches('main, [role="main"], body')
    ) {
      const cls = (
        (parent.id || '') +
        ' ' +
        (parent.className || '') +
        ' ' +
        (parent.getAttribute('data-section') || '')
      ).toLowerCase();
      if (
        /\bpinned[-_]?(section|container|grid|list|projects|group)?\b|\bfixad[ao]s?[-_]?(secao|container|grade|lista|projetos|grupo)?\b/.test(
          cls
        )
      ) {
        if (!/unpinned|não[-_]?fixad|recent|tod/i.test(cls)) {
          return true;
        }
      }
      parent = parent.parentElement;
    }

    // 2. Posição relativa a cabeçalhos de seção visíveis na página
    const allHeadings = Array.from(
      document.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .section-header, .section-title, [class*="section-title" i], [class*="section-header" i], [class*="group-title" i]'
      )
    ).filter((h) => visible(h) && !h.closest('#cca-root'));

    let lastPrecedingHeading = null;
    for (const h of allHeadings) {
      if (h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) {
        lastPrecedingHeading = h;
      }
    }

    if (lastPrecedingHeading) {
      const ht = (lastPrecedingHeading.textContent || '').trim().toLowerCase();
      if (
        /\bfixad[ao]s?\b|\bpinned\b/.test(ht) &&
        !/não fixad|not pinned|unpinn|recent|tod|outr|all\b/.test(ht)
      ) {
        return true;
      }
    }

    return false;
  }

  function isNotebookPinned(card) {
    if (!card) return false;
    if (card.dataset.ccaIsPinned === '1' || card.dataset.ccaPinned === '1') return true;
    if (cardHasPinIndicators(card)) return true;
    if (isCardInPinnedSection(card)) return true;
    return false;
  }

  function titleIsProtected(title, protectList) {
    if (!title || !protectList.length) return false;
    const lower = title.toLowerCase();
    return protectList.some((p) => lower.includes(p.toLowerCase()));
  }

  function isMoreButton(btn) {
    if (!btn) return false;
    if (btn.classList.contains('project-button-more')) return true;
    const label = (
      (btn.getAttribute('aria-label') || '') +
      ' ' +
      (btn.getAttribute('title') || '') +
      ' ' +
      (btn.textContent || '')
    ).toLowerCase();
    if (/ações|acoes|action|option|opç|mais|more|menu|more_vert|more_horiz/.test(label)) {
      return true;
    }
    const icon = btn.querySelector('mat-icon, .material-symbols-outlined, .material-icons, svg');
    if (icon) {
      const iconText = (icon.textContent || '').trim().toLowerCase();
      if (/more_vert|more_horiz|menu/.test(iconText)) return true;
    }
    return false;
  }

  function findNotebookCards() {
    const selectors = [
      'project-button',
      '.project-button',
      '[class*="project-button"]',
      '.project-card',
      '[class*="project-card"]',
      'mat-card[class*="project"]',
      'a[href*="/notebook/"]',
      '[data-project-id]'
    ];
    const found = [];
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        if (!el || el.closest('#cca-root')) continue;
        const card = el.closest('project-button') || el;
        if (!found.includes(card)) {
          found.push(card);
        }
      }
    }
    return found;
  }

  /** Cards de notebook elegíveis para exclusão (não fixados e sem texto protetor). */
  function findDeletableNotebooks(protectList, skipTitles) {
    const skipped = skipTitles || new Set();
    const cards = findNotebookCards();

    return cards.filter((card) => {
      if (card.closest('#cca-root')) return false;
      if (card.dataset.ccaSkipDelete === '1' || card.dataset.ccaIsPinned === '1') return false;
      if (isNotebookPinned(card)) return false;
      const title = notebookTitle(card);
      if (!title) return false;
      if (skipped.has(title.toLowerCase())) return false;
      if (titleIsProtected(title, protectList)) return false;
      const more = findNotebookMoreButton(card);
      return !!more;
    });
  }

  function findNotebookMoreButton(card) {
    if (!card) return null;
    const direct =
      card.querySelector('button.project-button-more') ||
      card.querySelector(
        'button[aria-label*="ações do projeto" i], button[aria-label*="ações" i], button[aria-label*="Project Actions" i], button[aria-label*="More options" i], button[aria-label*="Mais opções" i], button[aria-label*="Options" i], button[aria-label*="Opções" i]'
      );
    if (direct) return direct;
    for (const btn of card.querySelectorAll('button')) {
      if (isMoreButton(btn)) return btn;
    }
    return null;
  }

  function menuItemLooksLikeDelete(el) {
    const t = (
      (el.getAttribute('aria-label') || '') +
      ' ' +
      (el.textContent || '')
    )
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!t) return false;
    // Evita "Desafixar" / "Unpin" e itens de compartilhamento.
    if (
      /desafixar|desafix|unpin|desfij|désépingl|loslös|renomear|rename|compartilh|share|abrir|open|mover|move|copiar|copy/.test(
        t
      )
    ) {
      return false;
    }
    // "Fixar"/"Pin" sozinhos não são exclusão.
    if (/^(fixar|pin|unpin|keep|desafixar)$/.test(t)) return false;
    return /exclu|delete|apagar|remover notebook|delete notebook|remove notebook/.test(t);
  }

  function findOpenDeleteMenuItem() {
    const items = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], button.mat-mdc-menu-item, .mat-mdc-menu-item, .mat-menu-item'
      )
    );
    return (
      items.find((el) => {
        if (!menuItemLooksLikeDelete(el)) return false;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return r.width > 0 || r.height > 0 || style.opacity !== '0';
      }) || null
    );
  }

  function buttonLabel(el) {
    return (
      (el.getAttribute('aria-label') || '') +
      ' ' +
      (el.innerText || el.textContent || '')
    )
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Diálogo "Excluir o notebook de todos os lugares?" (não o menu ⋮). */
  function findDeleteConfirmDialog() {
    const nodes = Array.from(
      document.querySelectorAll(
        'mat-dialog-container, [role="dialog"], .mat-mdc-dialog-container'
      )
    );
    for (const pane of document.querySelectorAll('.cdk-overlay-pane')) {
      if (pane.querySelector('mat-dialog-container, [role="dialog"], .mat-mdc-dialog-container')) {
        continue;
      }
      const t = (pane.innerText || '').toLowerCase();
      if (
        (/exclu|delete/.test(t) && /notebook/.test(t)) ||
        /de todos os lugares|from all/.test(t)
      ) {
        nodes.push(pane);
      }
    }

    for (const dlg of nodes) {
      if (!visible(dlg) && (dlg.getBoundingClientRect?.().width || 0) <= 0) continue;
      const t = (dlg.innerText || '').toLowerCase();
      if (!t) continue;
      if (
        /exclu(ir)? o notebook|delete (the )?notebook|de todos os lugares|permanentemente exclu|permanently delete|from all (places|locations)/.test(
          t
        )
      ) {
        return dlg;
      }
      const labels = Array.from(dlg.querySelectorAll('button, [role="button"]')).map((b) =>
        buttonLabel(b).toLowerCase()
      );
      if (
        labels.some((l) => /^cancel(ar)?$/.test(l.trim())) &&
        labels.some((l) => /^(delete|excluir)$/.test(l.trim()))
      ) {
        return dlg;
      }
    }
    return null;
  }

  function findDeleteConfirmButton() {
    const dlg = findDeleteConfirmDialog();
    if (!dlg) return null;

    const btns = Array.from(dlg.querySelectorAll('button, [role="button"]')).filter((b) => {
      if (b.getAttribute('role') === 'menuitem') return false;
      if (b.classList.contains('mat-mdc-menu-item')) return false;
      if (b.closest('[role="menu"], .mat-mdc-menu-panel')) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || visible(b);
    });

    const textOf = (b) =>
      (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const exact = btns.find((b) => {
      const t = textOf(b);
      return t === 'delete' || t === 'excluir';
    });
    if (exact) return exact;

    const actions = dlg.querySelector(
      'mat-dialog-actions, .mat-mdc-dialog-actions, [class*="dialog-actions"]'
    );
    if (actions) {
      const actionBtns = Array.from(actions.querySelectorAll('button, [role="button"]'));
      const primary = actionBtns.find((b) => {
        const t = textOf(b);
        return /delete|exclu|apagar/.test(t) && !/cancel|cancelar/.test(t);
      });
      if (primary) return primary;
      if (actionBtns.length) return actionBtns[actionBtns.length - 1];
    }

    return (
      btns.find((b) => {
        const t = textOf(b);
        if (/cancel|cancelar|fechar|close|manter|keep/.test(t)) return false;
        return /delete|exclu|apagar/.test(t);
      }) || null
    );
  }

  function robustClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    } catch {
      // ignore
    }
    try {
      el.focus?.();
    } catch {
      // ignore
    }
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch {
      try {
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
      } catch {
        // ignore
      }
    }
    el.click();
    return true;
  }

  async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 120 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!state.deletingNotebooks) return null;
      const value = predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  /**
   * Fecha menu/tooltip sem Escape: Escape quebra tooltips do Google
   * (removeListeners) e trava exclusões seguintes.
   */
  function dismissOpenMenus() {
    try {
      const backdrop = document.querySelector(
        '.cdk-overlay-backdrop, .mat-drawer-backdrop, .cdk-overlay-transparent-backdrop'
      );
      if (backdrop) {
        backdrop.click();
        return;
      }
      // Clique neutro fora dos cards (não no painel da extensão).
      const root = document.getElementById('cca-root');
      const target = document.querySelector('main, [role="main"], body');
      if (target && (!root || !root.contains(target))) {
        target.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
        );
      }
    } catch {
      // ignore
    }
  }

  /** Se um modal de exclusão ficou aberto, confirma antes de seguir. */
  async function confirmPendingDeleteDialog() {
    const btn = findDeleteConfirmButton();
    if (!btn) return false;
    dlog('confirmando modal de exclusão pendente', buttonLabel(btn));
    robustClick(btn);
    await waitFor(() => !findDeleteConfirmDialog(), { timeoutMs: 8000, intervalMs: 150 });
    await sleep(600);
    return !findDeleteConfirmDialog();
  }

  /** Após exclusão, a lista some por um instante no re-render — espera estabilizar. */
  async function waitForDeletableList(protectList, skipTitles, { timeoutMs = 5000 } = {}) {
    const start = Date.now();
    let emptyStreak = 0;
    while (Date.now() - start < timeoutMs) {
      if (!state.deletingNotebooks) return [];
      const list = findDeletableNotebooks(protectList, skipTitles);
      if (list.length) return list;
      emptyStreak += 1;
      // Rola a grade para forçar cards virtuais a montarem.
      if (emptyStreak === 3 || emptyStreak === 8) {
        try {
          window.scrollBy(0, 400);
        } catch {
          // ignore
        }
      }
      if (emptyStreak === 12) {
        try {
          window.scrollTo(0, 0);
        } catch {
          // ignore
        }
      }
      await sleep(250);
    }
    return findDeletableNotebooks(protectList, skipTitles);
  }

  async function deleteOneNotebook(card) {
    const title = notebookTitle(card);

    // ── Camada 1 de proteção: Verificação prévia no card ──
    if (isNotebookPinned(card)) {
      dlog('ABORTADO: Notebook fixado detectado antes de abrir menu:', title);
      card.dataset.ccaSkipDelete = '1';
      card.dataset.ccaIsPinned = '1';
      return { ok: false, title, reason: 'notebook fixado' };
    }

    if (findDeleteConfirmDialog()) {
      const confirmed = await confirmPendingDeleteDialog();
      if (confirmed) return { ok: true, title, reason: 'modal pendente confirmado' };
    }

    const more = findNotebookMoreButton(card);
    if (!more) return { ok: false, title, reason: 'menu não encontrado' };

    try {
      more.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    } catch {
      // ignore
    }
    await sleep(250);
    dismissOpenMenus();
    await sleep(150);
    robustClick(more);
    await sleep(300);

    // ── Camada 2 de proteção: Inspeção de todos os itens do menu aberto ──
    // Se o menu contiver a opção "Desafixar" / "Unpin", este notebook É DEFINITIVAMENTE FIXADO.
    const allOpenMenuItems = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], button.mat-mdc-menu-item, .mat-mdc-menu-item, .mat-menu-item'
      )
    );

    const isPinnedFromMenu = allOpenMenuItems.some((item) => {
      const t = (
        (item.getAttribute('aria-label') || '') +
        ' ' +
        (item.getAttribute('title') || '') +
        ' ' +
        (item.innerText || item.textContent || '')
      )
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (/desafix|unpin|desfij|désépingl|loslös/.test(t)) {
        return true;
      }
      return false;
    });

    if (isPinnedFromMenu) {
      dlog('ABORTADO: Notebook está FIXADO (detectado no menu ⋮ aberto):', title);
      card.dataset.ccaSkipDelete = '1';
      card.dataset.ccaIsPinned = '1';
      dismissOpenMenus();
      await sleep(200);
      return { ok: false, title, reason: 'notebook fixado (detectado no menu ⋮)' };
    }

    const menuItem = await waitFor(findOpenDeleteMenuItem, {
      timeoutMs: 5000,
      intervalMs: 120,
    });
    if (!menuItem) {
      dismissOpenMenus();
      return { ok: false, title, reason: 'opção Excluir não apareceu' };
    }
    robustClick(menuItem);

    const confirmBtn = await waitFor(findDeleteConfirmButton, {
      timeoutMs: 10000,
      intervalMs: 150,
    });
    if (!confirmBtn) {
      dismissOpenMenus();
      return { ok: false, title, reason: 'modal Delete não apareceu' };
    }
    dlog('clicando confirmar exclusão', buttonLabel(confirmBtn));
    robustClick(confirmBtn);

    let closed = await waitFor(() => !findDeleteConfirmDialog(), {
      timeoutMs: 8000,
      intervalMs: 150,
    });
    if (!closed && findDeleteConfirmDialog()) {
      const retry = findDeleteConfirmButton();
      if (retry) {
        dlog('reintento Delete no modal');
        robustClick(retry);
      }
      closed = await waitFor(() => !findDeleteConfirmDialog(), {
        timeoutMs: 6000,
        intervalMs: 150,
      });
    }

    if (findDeleteConfirmDialog()) {
      return { ok: false, title, reason: 'modal Delete ainda aberto' };
    }

    // Espera o card sumir / título sair da lista (re-render Angular).
    await waitFor(
      () => {
        if (!document.contains(card)) return true;
        const still = Array.from(
          document.querySelectorAll('project-button, .project-button, [class*="project-button"]')
        ).some((el) => notebookTitle(el) === title);
        return !still;
      },
      { timeoutMs: 4000, intervalMs: 200 }
    );
    await sleep(700);
    return { ok: true, title };
  }

  function updateDeleteButtons() {
    const deleteBtn = rootEl?.querySelector('#cca-delete-notebooks');
    const stopBtn = rootEl?.querySelector('#cca-stop-delete-notebooks');
    if (deleteBtn) deleteBtn.disabled = !!state.deletingNotebooks;
    if (stopBtn) stopBtn.disabled = !state.deletingNotebooks;
  }

  function stopDeleteNotebooks() {
    if (!state.deletingNotebooks) {
      setStatus('Nenhuma limpeza em andamento.');
      return;
    }
    state.deletingNotebooks = false;
    updateDeleteButtons();
    disconnectArmedKeepalive();
    dismissOpenMenus();
    setStatus('Limpeza interrompida.');
    dlog('limpeza: parada pelo usuário');
  }

  async function deleteUnpinnedNotebooks() {
    if (!isNotebookLM()) {
      setStatus('Esta opção só funciona na página inicial do NotebookLM.');
      return;
    }
    if (state.deletingNotebooks) {
      setStatus('Exclusão já em andamento…');
      return;
    }
    if (state.armed) {
      setStatus('Pare a execução automática antes de excluir notebooks.');
      return;
    }

    persistUiFields();
    const protectList = parseProtectTitles();
    const skipTitles = new Set();

    const allCards = findNotebookCards();
    const pinnedCards = allCards.filter(isNotebookPinned);
    const preview = findDeletableNotebooks(protectList, skipTitles);

    dlog('NotebookLM limpeza:', {
      totalCards: allCards.length,
      pinnedCount: pinnedCards.length,
      eligibleCount: preview.length,
      protectedTitles: protectList,
    });

    if (!preview.length) {
      if (allCards.length === 0) {
        setStatus(
          'Nenhum card de notebook encontrado na página. Certifique-se de estar na página inicial do NotebookLM.'
        );
      } else if (pinnedCards.length === allCards.length) {
        setStatus(
          `Nenhum notebook elegível: todos os <strong>${allCards.length}</strong> notebooks estão fixados.`
        );
      } else {
        setStatus(
          `Nenhum notebook elegível (${allCards.length} no total: ${pinnedCards.length} fixado(s), demais protegidos pelo texto do título).`
        );
      }
      return;
    }

    const sample = preview
      .slice(0, 5)
      .map((c) => notebookTitle(c))
      .join(' · ');
    const ok = window.confirm(
      `Excluir ${preview.length} notebook(s) NÃO FIXADO(S)?\n\n` +
        `Notebooks fixados e os protegidos por título serão preservados.\n\n` +
        (protectList.length
          ? `Protegidos (título contém): ${protectList.join(', ')}\n\n`
          : '') +
        `Exemplos: ${sample}${preview.length > 5 ? '…' : ''}`
    );
    if (!ok) {
      setStatus('Exclusão cancelada.');
      return;
    }

    state.deletingNotebooks = true;
    setRunningTabVisual();
    // Keepalive do SW evita throttle de timers com a aba/navegador sem foco.
    connectArmedKeepalive();
    setNlmSectionOpen(true);
    updateDeleteButtons();
    updateFab();

    let deleted = 0;
    let failed = 0;
    const failCounts = new Map(); // title -> tentativas
    const maxPasses = Math.max(preview.length * 4, 100);
    let passes = 0;
    let consecutiveEmpty = 0;
    let stoppedByUser = false;

    try {
      while (state.deletingNotebooks && passes < maxPasses) {
        passes += 1;

        try {
          if (findDeleteConfirmDialog()) {
            setStatus('Confirmando modal <strong>Delete</strong>…');
            const confirmed = await confirmPendingDeleteDialog();
            if (!state.deletingNotebooks) {
              stoppedByUser = true;
              break;
            }
            if (confirmed) {
              deleted += 1;
              consecutiveEmpty = 0;
              await sleep(700);
              continue;
            }
          }

          if (!state.deletingNotebooks) {
            stoppedByUser = true;
            break;
          }

          const list = await waitForDeletableList(protectList, skipTitles, {
            timeoutMs: consecutiveEmpty > 0 ? 4500 : 1200,
          });
          if (!state.deletingNotebooks) {
            stoppedByUser = true;
            break;
          }
          if (!list.length) {
            consecutiveEmpty += 1;
            // Só encerra após várias checagens vazias (evita parar no re-render).
            if (consecutiveEmpty >= 3) {
              dlog('lista vazia após estabilizar — fim', { deleted, failed, passes });
              break;
            }
            setStatus('Aguardando a lista de notebooks atualizar…');
            await sleep(800);
            continue;
          }
          consecutiveEmpty = 0;

          const card = list[0];
          const title = notebookTitle(card);
          setStatus(
            `Excluindo <strong>${deleted + 1}</strong>… ` +
              `"${escapeHtml(title.slice(0, 60))}"` +
              ` · restam ~${list.length}`
          );

          const result = await deleteOneNotebook(card);
          if (!state.deletingNotebooks) {
            stoppedByUser = true;
            break;
          }
          if (result.ok) {
            deleted += 1;
            failCounts.delete(title.toLowerCase());
            dlog('notebook excluído', result.title);
          } else if (result.reason?.includes('fixado')) {
            const key = title.toLowerCase();
            skipTitles.add(key);
            card.dataset.ccaSkipDelete = '1';
            card.dataset.ccaIsPinned = '1';
            dlog('notebook fixado preservado:', result.title);
            setStatus(`Preservando notebook fixado: "${escapeHtml(title.slice(0, 50))}"`);
            await sleep(300);
          } else {
            const key = title.toLowerCase();
            const n = (failCounts.get(key) || 0) + 1;
            failCounts.set(key, n);
            dlog('falha ao excluir notebook', result, `tentativa ${n}`);
            if (n >= 3) {
              failed += 1;
              skipTitles.add(key);
              card.dataset.ccaSkipDelete = '1';
              setStatus(
                `Pulando após 3 falhas: "${escapeHtml(title.slice(0, 50))}" (${escapeHtml(result.reason || '')})`
              );
            } else {
              // Não marca skip permanente — tenta de novo depois.
              dismissOpenMenus();
              await sleep(600);
            }
          }
          await sleep(600);
        } catch (err) {
          dlog('erro no loop de exclusão (continua)', err);
          dismissOpenMenus();
          await sleep(800);
        }
      }
      if (!state.deletingNotebooks) stoppedByUser = true;
    } finally {
      state.deletingNotebooks = false;
      updateDeleteButtons();
      disconnectArmedKeepalive();
      updateFab();
    }

    const left = findDeletableNotebooks(protectList, skipTitles).length;
    if (stoppedByUser) {
      setStatus(
        `Limpeza interrompida: <strong>${deleted}</strong> excluído(s)` +
          (failed ? `, ${failed} falha(s)` : '') +
          (left ? `, ${left} ainda elegível(is)` : '') +
          '.'
      );
    } else {
      setStatus(
        `Exclusão concluída: <strong>${deleted}</strong> excluído(s)` +
          (failed ? `, ${failed} falha(s)` : '') +
          (left ? `, ${left} ainda elegível(is)` : '') +
          (passes >= maxPasses ? ' · limite de tentativas' : '') +
          '.'
      );
      setFinishedTabVisual('Exclusão de notebooks concluída');
    }
  }

  // ─── UI ──────────────────────────────────────────────────────────

  function setStatus(html) {
    if (statusEl) statusEl.innerHTML = html;
  }

  /** Sufixo de status: "restam N" ou, na última resposta, "última resposta". */
  function restHtml() {
    return state.finishing
      ? '<strong>última resposta</strong>'
      : `restam <strong>${state.remaining}</strong>`;
  }

  /** Encerra a execução após a IA terminar a resposta da última inserção. */
  function finishRun(reason) {
    state.armed = false;
    state.finishing = false;
    state.phase = 'idle';
    state.pendingSend = false;
    state.pendingSendSince = 0;
    state.retrySend = false;
    state.stopTextBaseline = null;
    disconnectArmedKeepalive();
    stopTimer();
    updateFab();
    setStatus(`Concluído. IA terminou a última resposta (${reason}).`);
    setFinishedTabVisual(`Concluído (${reason})`);
  }

  // ─── Temporizador ────────────────────────────────────────────────

  /** Zera e inicia a contagem (chamado no Iniciar). */
  function startTimer() {
    state.timerStart = Date.now();
    state.timerStop = 0;
    state.timerRunning = true;
    updateTimerLine();
  }

  /** Congela a contagem no valor atual (chamado ao concluir/parar). */
  function stopTimer() {
    if (!state.timerRunning) return;
    state.timerStop = Date.now();
    state.timerRunning = false;
    updateTimerLine();
  }

  /** ms → "mm:ss" ou "h:mm:ss". */
  function formatClock(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  /**
   * Linha do temporizador: tempo total (ao vivo enquanto roda) e tempo médio
   * por string = tempo total ÷ total de ocorrências da string na página.
   */
  function updateTimerLine() {
    if (!rootEl) return;
    const el = rootEl.querySelector('#cca-timer');
    if (!el) return;
    if (!state.timerStart) {
      el.style.display = 'none';
      return;
    }

    const end = state.timerRunning ? Date.now() : state.timerStop;
    const elapsed = Math.max(0, end - state.timerStart);
    let html = `⏱ Tempo: <strong>${formatClock(elapsed)}</strong>`;
    html += state.timerRunning ? '' : ' · concluído';

    // Média por string. countMarker() força layout da página, então só
    // recalcula com o painel aberto (mesma regra da linha de contagem).
    if (state.panelOpen) {
      // "Total de strings na página": ocorrências do marcador quando em modo
      // contagem; senão, número de inserções já enviadas.
      const strings = markerActive() ? countMarker() : state.times - state.remaining;
      if (strings >= 1) {
        const avgSec = elapsed / strings / 1000;
        html += ` · média/string: <strong>${avgSec.toFixed(1)}s</strong>`;
      }
    }

    el.style.display = '';
    el.innerHTML = html;
  }

  /** Linha de contagem sempre visível no painel — segue ativa após concluir. */
  function updateCountLine() {
    if (!rootEl) return;
    const el = rootEl.querySelector('#cca-count');
    if (!el) return;
    if (!markerActive()) {
      el.style.display = 'none';
      return;
    }
    // Painel fechado: não recalcula (countMarker força layout da página).
    if (!state.panelOpen) return;
    const details = countMarkerDetails();
    let txt = details.items
      .map((item) => {
        const max = getMarkerMax(item.marker);
        return max >= 1 ? `${item.marker}: ${item.count}/${max}` : `${item.marker}: ${item.count}`;
      })
      .join(' · ');
    if (state.armed && state.markerBaseline !== null) {
      txt += ` · novas: ${Math.max(0, state.markerLast - state.markerBaseline)}`;
    }
    el.style.display = '';
    el.textContent = txt;
  }

  function updateFab() {
    if (!fabEl) return;
    fabEl.dataset.active = state.armed || state.deletingNotebooks ? '1' : '0';
    fabEl.title = state.deletingNotebooks
      ? 'Limpeza de notebooks em andamento'
      : state.armed
        ? state.finishing
          ? 'Ativo — aguardando última resposta'
          : `Ativo — restam ${state.remaining}`
        : 'Chat Continue Auto';
  }

  function persistUiFields() {
    const textEl = rootEl?.querySelector('#cca-text');
    const timesEl = rootEl?.querySelector('#cca-times');
    const markerEl = rootEl?.querySelector('#cca-marker');
    const minEl = rootEl?.querySelector('#cca-min');
    const stopEl = rootEl?.querySelector('#cca-stop-text');
    const protectEl = rootEl?.querySelector('#cca-protect-titles');
    if (textEl) state.text = textEl.value;
    if (timesEl) state.times = Math.max(1, parseInt(timesEl.value, 10) || 1);
    if (markerEl) state.marker = markerEl.value;
    if (minEl) state.minNew = Math.max(1, parseInt(minEl.value, 10) || 1);
    if (stopEl) state.stopText = stopEl.value;
    if (protectEl) state.protectTitles = protectEl.value;

    if (rootEl) {
      const maxInputs = rootEl.querySelectorAll('.cca-marker-max-input');
      for (const input of maxInputs) {
        const key = input.dataset.markerKey;
        if (key) {
          state.markerMax[key] = Math.max(0, parseInt(input.value, 10) || 0);
        }
      }
    }

    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          text: state.text,
          savedTexts: state.savedTexts,
          times: state.times,
          marker: state.marker,
          minNew: state.minNew,
          markerMax: state.markerMax,
          stopText: state.stopText,
          protectTitles: state.protectTitles,
          nlmSectionOpen: state.nlmSectionOpen,
          visible: state.visible,
        },
      });
    } catch {
      // storage indisponível
    }
  }

  function isSavedText(text) {
    if (!text) return false;
    return state.savedTexts.some((item) => {
      const itemText = typeof item === 'string' ? item : item.text;
      return itemText === text;
    });
  }

  function updateSaveTextButton() {
    const textEl = rootEl?.querySelector('#cca-text');
    const saveBtn = rootEl?.querySelector('#cca-save-text');
    const tagWrap = rootEl?.querySelector('#cca-save-tag-wrap');
    const tagInput = rootEl?.querySelector('#cca-save-tag');
    if (!textEl || !saveBtn) return;
    const text = textEl.value.trim();
    const alreadySaved = isSavedText(text);

    if (alreadySaved || !text) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Já salvo';
      saveBtn.title = !text
        ? 'Digite um texto antes de salvar.'
        : 'Este texto já está salvo.';
      if (tagWrap) tagWrap.style.display = 'none';
    } else {
      saveBtn.textContent = 'Salvar texto atual';
      if (tagWrap) tagWrap.style.display = 'block';

      const tag = tagInput ? tagInput.value.trim() : '';
      const hasTag = tag.length > 0;
      saveBtn.disabled = !hasTag;
      saveBtn.title = !hasTag
        ? 'Preencha o campo de tag para salvar.'
        : 'Adicionar o texto atual à lista de textos salvos.';
    }
  }

  function renderSavedTexts() {
    const listEl = rootEl?.querySelector('#cca-saved-text-list');
    if (!listEl) return;
    listEl.replaceChildren();

    if (state.savedTexts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'cca-saved-empty';
      empty.textContent = 'Nenhum texto salvo.';
      listEl.appendChild(empty);
      updateSaveTextButton();
      return;
    }

    state.savedTexts.forEach((item, index) => {
      const text = typeof item === 'string' ? item : item.text;
      const tag = (typeof item === 'object' && item?.tag ? item.tag : '').trim() || 'Geral';

      const row = document.createElement('div');
      row.className = 'cca-saved-row';
      row.setAttribute('role', 'listitem');

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'cca-saved-select';
      selectBtn.dataset.savedTextIndex = String(index);
      selectBtn.title = `Usar este texto [${tag}]`;

      const tagBadge = document.createElement('span');
      tagBadge.className = 'cca-saved-tag-badge';
      tagBadge.textContent = tag;

      const textBody = document.createElement('span');
      textBody.className = 'cca-saved-text-body';
      textBody.textContent = text;

      selectBtn.append(tagBadge, textBody);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'cca-saved-delete';
      deleteBtn.dataset.deleteSavedTextIndex = String(index);
      deleteBtn.setAttribute('aria-label', `Excluir texto salvo ${index + 1}`);
      deleteBtn.title = 'Excluir este texto salvo';
      deleteBtn.textContent = '×';

      row.append(selectBtn, deleteBtn);
      listEl.appendChild(row);
    });
    updateSaveTextButton();
  }

  function setSavedTextsOpen(open) {
    const dropdown = rootEl?.querySelector('#cca-saved-dropdown');
    const textEl = rootEl?.querySelector('#cca-text');
    if (!dropdown || !textEl) return;
    if (open) renderSavedTexts();
    dropdown.dataset.open = open ? '1' : '0';
    textEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function saveCurrentText() {
    const textEl = rootEl?.querySelector('#cca-text');
    const tagInput = rootEl?.querySelector('#cca-save-tag');
    if (!textEl) return;
    const text = textEl.value.trim();
    if (!text || isSavedText(text)) {
      updateSaveTextButton();
      return;
    }

    const tag = tagInput ? tagInput.value.trim() : '';
    if (!tag) {
      if (tagInput) tagInput.focus();
      updateSaveTextButton();
      return;
    }

    textEl.value = text;
    state.text = text;
    state.savedTexts.unshift({ text, tag });
    if (tagInput) tagInput.value = '';
    persistUiFields();
    renderSavedTexts();
  }

  function selectSavedText(index) {
    const item = state.savedTexts[index];
    const text = typeof item === 'string' ? item : item?.text;
    const textEl = rootEl?.querySelector('#cca-text');
    if (typeof text !== 'string' || !textEl) return;
    textEl.value = text;
    state.text = text;
    persistUiFields();
    updateSaveTextButton();
    textEl.focus();
    textEl.setSelectionRange(text.length, text.length);
    setSavedTextsOpen(false);
  }

  function deleteSavedText(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.savedTexts.length) return;
    state.savedTexts.splice(index, 1);
    persistUiFields();
    renderSavedTexts();
  }

  function renderMarkerMaxInputs() {
    const listEl = rootEl?.querySelector('#cca-marker-max-list');
    if (!listEl) return;
    const markerEl = rootEl?.querySelector('#cca-marker');
    const markers = parseMarkerStrings(markerEl ? markerEl.value : state.marker);

    listEl.replaceChildren();

    if (markers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cca-marker-max-empty';
      empty.textContent = 'Nenhuma string informada acima.';
      listEl.appendChild(empty);
      return;
    }

    for (const marker of markers) {
      const key = markerKey(marker);
      const row = document.createElement('div');
      row.className = 'cca-marker-max-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'cca-marker-max-name';
      nameSpan.title = marker;
      nameSpan.textContent = marker;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '9999';
      input.step = '1';
      input.className = 'cca-marker-max-input';
      input.dataset.markerKey = key;
      input.value = String(getMarkerMax(marker));
      input.title = `Limite máximo para "${marker}" (0 = sem limite)`;

      const handleMaxChange = () => {
        state.markerMax[key] = Math.max(0, parseInt(input.value, 10) || 0);
        persistUiFields();
        updateCountLine();
      };
      input.addEventListener('input', handleMaxChange);
      input.addEventListener('change', handleMaxChange);

      row.append(nameSpan, input);
      listEl.appendChild(row);
    }
  }

  function setNlmSectionOpen(open) {
    state.nlmSectionOpen = !!open;
    const section = rootEl?.querySelector('#cca-nlm-section');
    if (section) section.dataset.open = state.nlmSectionOpen ? '1' : '0';
    const toggle = rootEl?.querySelector('#cca-nlm-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.nlmSectionOpen ? 'true' : 'false');
    }
    persistUiFields();
  }

  function toggleNlmSection() {
    setNlmSectionOpen(!state.nlmSectionOpen);
  }

  async function sendFirstNow(total) {
    state.pendingSend = true;
    state.pendingSendSince = Date.now();
    state.retrySend = false;
    state.lastSendAttemptAt = Date.now();
    setStatus(`Chat parado — enviando agora… (restam <strong>${total}</strong>)`);
    try {
      const sendResult = await sendMessage(state.text);
      if (sendResult) {
        state.remaining -= 1;
        if (state.remaining <= 0) {
          state.finishing = true;
          armWatchAfterSend(sendResult);
          setStatus('Última inserção enviada. Aguardando a IA terminar a resposta…');
        } else {
          armWatchAfterSend(sendResult);
          setStatus(`Enviado. Aguardando a IA terminar… (${restHtml()})`);
        }
      } else {
        dlog('sendFirstNow: falhou — reagendando', { hidden: pageLikelyBackgrounded() });
        state.retrySend = true;
        state.phase = 'watch';
        state.sawStreaming = true;
        state.lastSendAt = Date.now() - 5000;
        resetMarkerCounters();
        setStatus(
          pageLikelyBackgrounded()
            ? `Falha ao enviar (navegador em segundo plano). Continuando a tentar… (restam <strong>${total}</strong>)`
            : `IA ainda gerando ou envio bloqueado. Continuando a tentar… (restam <strong>${total}</strong>)`
        );
      }
    } catch (err) {
      dlog('sendFirstNow erro', err);
      state.retrySend = true;
      state.phase = 'watch';
      state.sawStreaming = true;
    } finally {
      state.pendingSend = false;
      state.pendingSendSince = 0;
      updateFab();
    }
  }

  function start() {
    setRunningTabVisual();
    if (state.deletingNotebooks) {
      setStatus('Pare a limpeza de notebooks antes de iniciar.');
      return;
    }
    persistUiFields();
    const timesEl = rootEl.querySelector('#cca-times');
    const n = Math.max(1, parseInt(timesEl.value, 10) || 1);
    state.times = n;
    state.remaining = n;
    state.armed = true;
    state.finishing = false;
    state.pendingSend = false;
    state.retrySend = false;
    state.stableTicks = 0;
    state.replyStableSince = 0;
    state.sawStreaming = false;
    state.sawHardStreaming = false;
    state.lastSendAttemptAt = 0;
    state.stopTextBaseline = stopTextActive() ? countStopText() : null;
    connectArmedKeepalive();
    startTimer();
    updateFab();

    // O detector de término continua automático; a lista, quando preenchida,
    // valida o conteúdo da resposta somente depois que esse término é detectado.
    state.phase = 'watch';
    state.lastSendAt = Date.now() - 5000;
    const reply = getLastReplySnapshot();
    state.lastReplySig = reply.signature;
    state.lastReplyEl = reply.element;
    state.lastReplyCount = reply.count;
    state.lastReplySource = reply.source;
    resetMarkerCounters(markerActive() ? countMarkerDetails() : null);

    const hardGenerating = hasHardStreamingSignal();
    if (hardGenerating || isGenerating()) {
      state.phase = 'streaming';
      state.sawStreaming = true;
      state.sawHardStreaming = hardGenerating;
      setStatus(`Ativo. Aguardando a IA terminar… (restam <strong>${n}</strong>)`);
    } else {
      // Chat parado: inserir texto + Enter imediatamente.
      state.phase = 'idle';
      void sendFirstNow(n);
    }
  }

  function stop() {
    clearTabVisuals();
    state.armed = false;
    state.finishing = false;
    state.remaining = 0;
    state.pendingSend = false;
    state.pendingSendSince = 0;
    state.retrySend = false;
    state.phase = 'idle';
    state.sawStreaming = false;
    state.sawHardStreaming = false;
    state.stopTextBaseline = null;
    disconnectArmedKeepalive();
    stopTimer();
    setStatus('Parado.');
    updateFab();
  }

  function setUiVisible(visible) {
    state.visible = !!visible;
    if (rootEl) {
      rootEl.dataset.hidden = state.visible ? '0' : '1';
    }
    if (!state.visible) {
      setPanelOpen(false);
    }
    persistUiFields();
  }

  function toggleUiVisible() {
    setUiVisible(!state.visible);
  }

  function setPanelOpen(open) {
    if (!rootEl) buildUi();
    state.panelOpen = !!open;
    const panel = rootEl.querySelector('#cca-panel');
    if (panel) panel.dataset.open = state.panelOpen ? '1' : '0';
    if (!state.panelOpen) setSavedTextsOpen(false);
  }

  function togglePanel() {
    setPanelOpen(!state.panelOpen);
  }

  function openPanel() {
    if (!state.visible) setUiVisible(true);
    setPanelOpen(true);
  }

  function buildUi() {
    const existing = document.getElementById('cca-root');
    if (existing) {
      rootEl = existing;
      statusEl = rootEl.querySelector('#cca-status');
      fabEl = rootEl.querySelector('#cca-fab');
      rootEl.dataset.hidden = state.visible ? '0' : '1';
      return;
    }

    rootEl = document.createElement('div');
    rootEl.id = 'cca-root';
    rootEl.dataset.hidden = state.visible ? '0' : '1';
    rootEl.innerHTML = `
      <div id="cca-panel" data-open="0">
        <h2>Chat Continue Auto <small style="font-weight:normal;opacity:.6">v${extVersion}</small></h2>
        <label for="cca-text" title="Texto que será digitado e enviado automaticamente no chat a cada repetição após a IA concluir a resposta.">Texto a inserir após a IA terminar <span class="cca-info" title="Texto que será digitado e enviado automaticamente no chat a cada repetição após a IA concluir a resposta.">ⓘ</span></label>
        <div id="cca-text-picker">
          <textarea id="cca-text" spellcheck="false"
            aria-haspopup="dialog" aria-expanded="false" aria-controls="cca-saved-dropdown"
            title="Clique para escolher um texto salvo ou digite um novo."></textarea>
          <div id="cca-saved-dropdown" data-open="0" role="dialog" aria-label="Textos salvos">
            <div class="cca-saved-header">
              <div class="cca-saved-header-row">
                <strong>Textos salvos</strong>
                <button type="button" id="cca-save-text">Salvar texto atual</button>
              </div>
              <div id="cca-save-tag-wrap" class="cca-save-tag-wrap" style="display:none;">
                <input type="text" id="cca-save-tag" placeholder="Nome da tag (obrigatório)" spellcheck="false" autocomplete="off" />
              </div>
            </div>
            <div id="cca-saved-text-list" role="list"></div>
          </div>
        </div>
        <label for="cca-marker" title="Alternativas aceitas na resposta, separadas por ponto e vírgula. Basta a resposta conter qualquer uma delas. Deixe vazio para não exigir string.">Strings aceitas na resposta (separe com ;) <span class="cca-info" title="Alternativas aceitas na resposta, separadas por ponto e vírgula. Basta a resposta conter qualquer uma delas. Deixe vazio para não exigir string.">ⓘ</span></label>
        <input id="cca-marker" type="text" spellcheck="false"
          placeholder="=ff=; Assunto:; outra string"
          title="Exemplo: =ff=; Assunto:. A comparação ignora maiúsculas/minúsculas." />
        <div id="cca-marker-max-container">
          <label title="Limite máximo de ocorrências na página para cada string (0 = sem limite). Ao atingir o limite de qualquer uma delas, a execução é interrompida.">Máx. total das strings na página (0 = sem limite) <span class="cca-info" title="Limite máximo de ocorrências na página para cada string (0 = sem limite). Ao atingir o limite de qualquer uma delas, a execução é interrompida.">ⓘ</span></label>
          <div id="cca-marker-max-list" class="cca-marker-max-list"></div>
        </div>
        <div id="cca-row">
          <div>
            <label for="cca-times" title="Quantidade total de vezes que a mensagem será inserida e enviada no chat (padrão: 100).">Quantas vezes <span class="cca-info" title="Quantidade total de vezes que a mensagem será inserida e enviada no chat (padrão: 100).">ⓘ</span></label>
            <input id="cca-times" type="number" min="1" max="9999" step="1" title="Quantidade total de vezes que a mensagem será inserida e enviada no chat (padrão: 100)." />
          </div>
          <div>
            <label for="cca-min" title="Quantidade mínima de ocorrências de pelo menos uma das strings aceitas na última resposta.">Mín. ocorrências aceitas <span class="cca-info" title="Quantidade mínima de ocorrências de pelo menos uma das strings aceitas na última resposta.">ⓘ</span></label>
            <input id="cca-min" type="number" min="1" max="999" step="1" title="Quantidade mínima de ocorrências de pelo menos uma das strings aceitas na última resposta." />
          </div>
        </div>
        <label for="cca-stop-text" title="Texto de parada verificado após a IA terminar a resposta. Se presente, encerra o ciclo de envios.">Texto de parada (verificado após a resposta terminar) <span class="cca-info" title="Texto de parada verificado após a IA terminar a resposta. Se presente, encerra o ciclo de envios.">ⓘ</span></label>
        <input id="cca-stop-text" type="text" spellcheck="false"
          placeholder="ex.: COMANDO FINALIZADO"
          title="Texto de parada verificado após a IA terminar a resposta. Se presente, encerra o ciclo de envios." />
        <div id="cca-nlm-section" style="display:none" data-open="0">
          <hr class="cca-sep" />
          <button type="button" id="cca-nlm-toggle" class="cca-collapse-toggle" aria-expanded="false" aria-controls="cca-nlm-body" title="Mostrar ou ocultar opções de limpeza do NotebookLM">
            <span class="cca-collapse-chevron" aria-hidden="true">▸</span>
            <span>NotebookLM — limpeza</span>
          </button>
          <div id="cca-nlm-body" class="cca-collapse-body" role="region" aria-labelledby="cca-nlm-toggle">
            <label for="cca-protect-titles" title="Textos separados por vírgula. Se o título do notebook contiver qualquer um deles, ele não será excluído.">Não excluir se o título contiver (vírgula) <span class="cca-info" title="Textos separados por vírgula. Se o título do notebook contiver qualquer um deles, ele não será excluído.">ⓘ</span></label>
            <input id="cca-protect-titles" type="text" spellcheck="false"
              placeholder="ex.: PETRO, RES-, Guia Mestre"
              title="Textos separados por vírgula. Se o título do notebook contiver qualquer um deles, ele não será excluído." />
            <div class="cca-nlm-actions">
              <button type="button" id="cca-delete-notebooks" title="Abre o menu ⋮ de cada notebook não fixado e exclui. Notebooks fixados e os que contêm os textos acima no título são preservados.">Excluir notebooks não fixados</button>
              <button type="button" id="cca-stop-delete-notebooks" disabled title="Interrompe a limpeza em andamento.">Parar limpeza</button>
            </div>
            <p class="cca-nlm-hint">
              Preserva rigorosamente notebooks fixados (ícone de alfinete, seção fixados e opção de desafixar)
              e os cujo título contenha qualquer texto do campo acima. Use na página inicial do NotebookLM.
            </p>
          </div>
        </div>
        <div id="cca-status">Configure e clique em Iniciar.</div>
        <div id="cca-count"></div>
        <div id="cca-timer" style="display:none"></div>
        <div id="cca-actions">
          <button type="button" id="cca-start">Iniciar</button>
          <button type="button" id="cca-stop">Parar</button>
        </div>
        <p id="cca-hint">
          A extensão sempre aguarda a IA terminar. Com a lista preenchida, o
          próximo envio só é liberado se a resposta concluída contiver pelo menos
          uma das strings (ex.: “=ff=” ou “Assunto:”), respeitando o mínimo.
          Separe alternativas com ponto e vírgula; deixe vazio para não exigir
          string. O texto de parada também só é verificado após a resposta terminar.
        </p>
      </div>
      <div id="cca-fab-wrap">
        <button type="button" id="cca-fab" title="Chat Continue Auto">↻</button>
      </div>
    `;
    (document.body || document.documentElement).appendChild(rootEl);

    statusEl = rootEl.querySelector('#cca-status');
    fabEl = rootEl.querySelector('#cca-fab');
    const textEl = rootEl.querySelector('#cca-text');
    const timesEl = rootEl.querySelector('#cca-times');
    const markerEl = rootEl.querySelector('#cca-marker');
    const minEl = rootEl.querySelector('#cca-min');
    const stopEl = rootEl.querySelector('#cca-stop-text');
    const protectEl = rootEl.querySelector('#cca-protect-titles');
    const nlmSection = rootEl.querySelector('#cca-nlm-section');

    textEl.value = state.text;
    timesEl.value = String(state.times);
    markerEl.value = state.marker;
    minEl.value = String(state.minNew);
    stopEl.value = state.stopText;
    if (protectEl) protectEl.value = state.protectTitles;
    if (nlmSection) {
      nlmSection.style.display = isNotebookLM() ? '' : 'none';
      nlmSection.dataset.open = state.nlmSectionOpen ? '1' : '0';
    }
    renderSavedTexts();
    renderMarkerMaxInputs();

    markerEl.addEventListener('input', () => {
      state.marker = markerEl.value;
      renderMarkerMaxInputs();
      persistUiFields();
      updateCountLine();
    });

    textEl.addEventListener('focus', () => setSavedTextsOpen(true));
    textEl.addEventListener('click', () => setSavedTextsOpen(true));
    textEl.addEventListener('input', () => {
      updateSaveTextButton();
      const dropdown = rootEl?.querySelector('#cca-saved-dropdown');
      if (dropdown?.dataset.open !== '1') setSavedTextsOpen(true);
    });
    textEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setSavedTextsOpen(false);
    });

    const saveTagInput = rootEl.querySelector('#cca-save-tag');
    if (saveTagInput) {
      saveTagInput.addEventListener('input', () => {
        updateSaveTextButton();
      });
      saveTagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveCurrentText();
        }
      });
      saveTagInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    rootEl.querySelector('#cca-save-text').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveCurrentText();
    });
    rootEl.querySelector('#cca-saved-text-list').addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const deleteBtn = target?.closest('[data-delete-saved-text-index]');
      if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        deleteSavedText(Number(deleteBtn.dataset.deleteSavedTextIndex));
        return;
      }
      const selectBtn = target?.closest('[data-saved-text-index]');
      if (!selectBtn) return;
      e.preventDefault();
      e.stopPropagation();
      selectSavedText(Number(selectBtn.dataset.savedTextIndex));
    });
    document.addEventListener('pointerdown', (e) => {
      const picker = rootEl?.querySelector('#cca-text-picker');
      if (picker && !picker.contains(e.target)) setSavedTextsOpen(false);
    });

    fabEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    rootEl.querySelector('#cca-start').addEventListener('click', start);
    rootEl.querySelector('#cca-stop').addEventListener('click', stop);
    const nlmToggle = rootEl.querySelector('#cca-nlm-toggle');
    if (nlmToggle) {
      nlmToggle.setAttribute('aria-expanded', state.nlmSectionOpen ? 'true' : 'false');
      nlmToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleNlmSection();
      });
    }
    const deleteNotebooksBtn = rootEl.querySelector('#cca-delete-notebooks');
    if (deleteNotebooksBtn) {
      deleteNotebooksBtn.addEventListener('click', () => {
        void deleteUnpinnedNotebooks();
      });
    }
    const stopDeleteBtn = rootEl.querySelector('#cca-stop-delete-notebooks');
    if (stopDeleteBtn) {
      stopDeleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        stopDeleteNotebooks();
      });
    }
    updateDeleteButtons();
    const persistEls = [textEl, timesEl, markerEl, minEl, stopEl];
    if (protectEl) persistEls.push(protectEl);
    for (const el of persistEls) {
      el.addEventListener('input', persistUiFields);
      el.addEventListener('change', persistUiFields);
    }
  }

  function loadSettings(cb) {
    try {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const s = data?.[STORAGE_KEY] || {};
        const saved = typeof s.text === 'string' ? s.text : '';
        // Mantém texto personalizado; migra só o default antigo.
        if (saved && !LEGACY_DEFAULT_TEXTS.has(saved)) state.text = saved;
        else state.text = DEFAULTS.text;
        const loadedSaved = Array.isArray(s.savedTexts)
          ? normalizeSavedTexts(s.savedTexts)
          : [];
        if (!loadedSaved.length) {
          state.savedTexts = DEFAULT_SAVED_TEXTS.map((item) => ({ ...item }));
        } else {
          const merged = [...loadedSaved];
          for (const defItem of DEFAULT_SAVED_TEXTS) {
            if (!merged.some((item) => item.text === defItem.text)) {
              merged.push({ ...defItem });
            }
          }
          state.savedTexts = merged;
        }
        state.times =
          Number.isFinite(s.times) && s.times !== LEGACY_DEFAULT_TIMES && s.times >= 1
            ? s.times
            : DEFAULTS.times;
        state.marker =
          typeof s.marker === 'string'
            ? LEGACY_DEFAULT_MARKERS.has(s.marker)
              ? DEFAULTS.marker
              : s.marker
            : DEFAULTS.marker;
        state.minNew =
          Number.isFinite(s.minNew) && s.minNew >= 1 ? s.minNew : DEFAULTS.minNew;
        state.markerMax = { ...DEFAULTS.markerMax };
        if (s.markerMax && typeof s.markerMax === 'object' && !Array.isArray(s.markerMax)) {
          for (const [k, v] of Object.entries(s.markerMax)) {
            if (Number.isFinite(v) && v >= 0) {
              state.markerMax[markerKey(k)] = v;
            }
          }
        } else if (
          Number.isFinite(s.maxTotal) &&
          s.maxTotal > 0 &&
          s.maxTotal !== LEGACY_DEFAULT_MAX_TOTAL
        ) {
          state.markerMax['=ff='] = s.maxTotal;
        }
        state.stopText =
          typeof s.stopText === 'string' ? s.stopText : DEFAULTS.stopText;
        state.protectTitles =
          typeof s.protectTitles === 'string' ? s.protectTitles : DEFAULTS.protectTitles;
        state.nlmSectionOpen =
          typeof s.nlmSectionOpen === 'boolean' ? s.nlmSectionOpen : DEFAULTS.nlmSectionOpen;
        state.visible =
          typeof s.visible === 'boolean' ? s.visible : DEFAULTS.visible;
        if (rootEl) {
          rootEl.dataset.hidden = state.visible ? '0' : '1';
        }
        cb();
      });
    } catch {
      cb();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'cca-ping') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'cca-tick') {
      // Compatibilidade com versões anteriores do service worker durante reload.
      runHeartbeat(msg.now);
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'cca-toggle-icon' || msg?.type === 'cca-toggle-visibility') {
      if (!rootEl) buildUi();
      toggleUiVisible();
      sendResponse({ ok: true, visible: state.visible });
      return true;
    }
    if (msg?.type === 'cca-clear-notification' || msg?.type === 'cca-clear-tab-badge') {
      clearTabVisuals();
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'cca-open-panel' || msg?.type === 'cca-toggle-panel') {
      if (!rootEl) buildUi();
      if (msg.type === 'cca-open-panel') openPanel();
      else togglePanel();
      sendResponse({ ok: true, open: state.panelOpen });
      return true;
    }
    return false;
  });

  try {
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY]?.newValue) {
        const newVal = changes[STORAGE_KEY].newValue;
        if (typeof newVal.visible === 'boolean' && newVal.visible !== state.visible) {
          state.visible = newVal.visible;
          if (rootEl) {
            rootEl.dataset.hidden = state.visible ? '0' : '1';
            if (!state.visible) setPanelOpen(false);
          }
        }
      }
    });
  } catch {
    // storage listener indisponível
  }

  window.addEventListener('cca-reopen', () => openPanel());

  // Ao voltar o foco/visibilidade, dispara um tick imediato (útil após minimizar).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.armed && !state.deletingNotebooks) return;
    dlog('visibility: aba visível de novo — tick imediato');
    if (!armedPort) connectArmedKeepalive();
    runHeartbeat();
  });

  loadSettings(() => {
    buildUi();
    setInterval(runHeartbeat, POLL_MS);
  });
})();
