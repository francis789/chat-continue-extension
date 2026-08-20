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
    'Execute o comando.',
    'Execute o comando. PROIBIDO qualquer tipo de texto antes ou depois do resumo.',
  ];
  const DEFAULTS = {
    text: DEFAULT_SAVED_TEXTS[0],
    savedTexts: DEFAULT_SAVED_TEXTS,
    times: 100,
    /** String que identifica texto de resposta da IA (modo contagem). */
    marker: '=ff=',
    /** Mínimo de NOVAS ocorrências do marcador antes de enviar. */
    minNew: 1,
    /** Máximo TOTAL de ocorrências na página — ao atingir, para (0 = sem limite). */
    maxTotal: 100,
    /** Texto que encerra as inserções após concluir a resposta da IA. */
    stopText: 'COMANDO FINALIZADO',
    /**
     * Textos (vírgula) que, se presentes no título, impedem a exclusão
     * automática de notebooks não fixados no NotebookLM.
     */
    protectTitles: '',
    /** Seção NotebookLM — limpeza expandida no painel. */
    nlmSectionOpen: false,
  };
  /** Default antigo — migra para o novo se o usuário nunca personalizou. */
  const LEGACY_DEFAULT_TEXTS = new Set(['continue', 'execute o comando']);
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
  /** Estabilidade mais longa no 1º envio (chat parado). */
  const FIRST_SEND_STABLE_MS = 4800;
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
    /** Último nudge do watchdog de progresso travado. */
    lastStuckNudgeAt: 0,
    panelOpen: false,
    /** Assinatura da última resposta (tamanho) para detectar estabilização. */
    lastReplySig: '',
    stableTicks: 0,
    /** Timestamp em que a assinatura da resposta passou a ficar igual (0 = mudou). */
    replyStableSince: 0,
    sawStreaming: false,
    /** Modo contagem (marcador definido pelo usuário). */
    marker: DEFAULTS.marker,
    minNew: DEFAULTS.minNew,
    maxTotal: DEFAULTS.maxTotal,
    /** Texto de parada: encerra somente após a resposta da IA terminar. */
    stopText: DEFAULTS.stopText,
    /** Contagem do texto de parada no Iniciar (null = ainda não registrada). */
    stopTextBaseline: null,
    /** Contagem do marcador no momento do último envio (null = registrar). */
    markerBaseline: null,
    /** Maior contagem já vista desde a baseline (imune a DOM virtualizado). */
    markerLast: 0,
    /** Ticks consecutivos sem ocorrência nova (fallback; preferir wall-clock). */
    markerStableTicks: 0,
    /** Timestamp em que a contagem do marcador parou de crescer (0 = cresceu). */
    markerStableSince: 0,
    /**
     * Última inserção já enviada; ainda aguardando a IA terminar de responder
     * (e atingir a ocorrência mínima da string) antes de encerrar de vez.
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

  function normalizeSavedTexts(value) {
    if (!Array.isArray(value)) return [];
    const unique = new Set();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (text) unique.add(text);
    }
    return [...unique];
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
    // Modo contagem: só sinais confiáveis contam; o resto é decidido pela
    // contagem de ocorrências do marcador definido pelo usuário.
    if (markerActive()) return false;
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

  function markerStableFor(ms) {
    return state.markerStableSince > 0 && Date.now() - state.markerStableSince >= ms;
  }

  function pageLikelyBackgrounded() {
    try {
      return document.hidden || document.visibilityState === 'hidden';
    } catch {
      return false;
    }
  }

  /** Última bolha conhecida do assistente nas interfaces suportadas. */
  function getLastAssistantReplyElement() {
    const groups = [
      document.querySelectorAll('[data-message-author-role="assistant"]'),
      document.querySelectorAll('[data-turn="assistant"]'),
      document.querySelectorAll('section[data-turn="assistant"]'),
      document.querySelectorAll('.font-claude-message'),
      document.querySelectorAll('.font-claude-response'),
      document.querySelectorAll('[data-is-streaming]'),
      document.querySelectorAll('model-response'),
    ];
    for (const list of groups) {
      if (!list.length) continue;
      const el = list[list.length - 1];
      if (!el || el.closest('#cca-root')) continue;
      return el;
    }
    return null;
  }

  /** Texto da última bolha do assistente — para detectar quando parou de crescer. */
  function getLastReplySignature() {
    const reply = getLastAssistantReplyElement();
    if (reply) {
      const t = (reply.innerText || '').trim();
      if (t) return `${t.length}:${t.slice(-80)}`;
    }
    // Genérico: texto do conteúdo principal (painel fica fora do <main>).
    const main = document.querySelector('main, [role="main"]');
    if (main && !main.contains(document.getElementById('cca-root'))) {
      const t = (main.innerText || '').trim();
      if (t) return `${t.length}:${t.slice(-80)}`;
    }
    return '';
  }

  // ─── Modo contagem (marcador do usuário) ─────────────────────────

  function markerActive() {
    return !!(state.marker && state.marker.trim()) && state.minNew >= 1;
  }

  function countIn(text, needle) {
    let count = 0;
    let i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) {
      count += 1;
      i += needle.length;
    }
    return count;
  }

  /**
   * Total de ocorrências do marcador no conteúdo da página (fora do painel).
   * Usa o <body> inteiro: em apps como o NotebookLM o chat fica fora do
   * <main>, o que zerava a contagem. O texto do próprio painel é descontado.
   */
  function countMarker() {
    const needle = state.marker;
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

  function resetMarkerCounters() {
    state.markerBaseline = null;
    state.markerLast = 0;
    state.markerStableTicks = 0;
    state.markerStableSince = 0;
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

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[aria-label="Enviar mensagem"]',
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Enviar" i]',
      'button[aria-label="Submit"]',
      'button[type="submit"][aria-label*="submit" i]',
      'form button[type="submit"]',
    ];
    for (const sel of selectors) {
      const el = queryAll(sel).find(
        (b) => !b.closest('#cca-root') && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      );
      if (el) return el;
    }
    // ChatGPT: botão com ícone de seta perto do composer
    const composer = findComposer();
    if (composer) {
      const form = composer.closest('form');
      if (form) {
        const btns = Array.from(form.querySelectorAll('button')).filter(
          (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && visible(b)
        );
        const sendLike = btns.find((b) => {
          const a = (b.getAttribute('aria-label') || '').toLowerCase();
          return a.includes('send') || a.includes('enviar');
        });
        if (sendLike) return sendLike;
        if (btns.length === 1) return btns[0];
      }
    }
    return null;
  }

  function composerHasText(el, text) {
    const got = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
    const want = text.replace(/\s+/g, ' ').trim();
    if (!want) return got.length > 0;
    return got.includes(want.slice(0, Math.min(24, want.length)));
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

  async function sendMessage(text) {
    try {
      dismissStopGeneratingDialog();

      const composer = findComposer();
      if (!composer) {
        dlog('sendMessage: composer NÃO encontrado');
        setStatus('Não achei o campo de mensagem nesta página.');
        return false;
      }

      dlog('sendMessage: composer =', composer.id || composer.className || composer.tagName, {
        hidden: pageLikelyBackgrounded(),
      });
      setStatus(`Campo achado (<code>${composer.id || composer.tagName}</code>). Inserindo…`);

      let ok = false;
      for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
        dismissStopGeneratingDialog();
        ok = setComposerText(composer, text);
        if (ok) break;
        dlog('sendMessage: inserção falhou, retry', attempt + 1);
        await sleep(250 + attempt * 200);
      }
      if (!ok) {
        dlog('sendMessage: inserção FALHOU no composer após retries');
        setStatus(
          pageLikelyBackgrounded()
            ? 'Aba em segundo plano bloqueou a inserção. Mantendo ativo — tentando de novo…'
            : 'Achei o campo, mas o site bloqueou a inserção. Tentando de novo…'
        );
        return false;
      }

      await sleep(BEFORE_SEND_MS);
      dismissStopGeneratingDialog();

      const sendBtn = findSendButton();
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
        state.lastSendAt = Date.now();
        return true;
      }

      pressEnter(composer);
      await sleep(250);
      if (dismissStopGeneratingDialog()) {
        dlog('sendMessage: popup Continuar gerando após Enter — envio NÃO concluído');
        return false;
      }
      const retry = findSendButton();
      if (retry) {
        retry.click();
        await sleep(250);
        if (dismissStopGeneratingDialog()) {
          dlog('sendMessage: popup Continuar gerando no retry — envio NÃO concluído');
          return false;
        }
        state.lastSendAt = Date.now();
        return true;
      }

      state.lastSendAt = Date.now();
      dismissStopGeneratingDialog();
      setStatus('Texto inserido. Se não enviou sozinho, pressione Enter no chat.');
      return true;
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
          dlog('watchdog: sem progresso — forçando ciclo', { sinceSend });
          state.lastStuckNudgeAt = now;
          state.sawStreaming = true;
          state.phase = 'streaming';
          state.stableTicks = 99;
          state.replyStableSince = now - 5000;
          state.markerStableTicks = 99;
          if (!state.markerStableSince) state.markerStableSince = now - STABLE_MS;
          if (markerActive() && state.markerBaseline !== null) {
            const need = state.markerBaseline + state.minNew;
            if (state.markerLast < need) state.markerLast = need;
          }
          void onGenerationEnded('watchdog sem progresso');
        }
      }
    } catch (err) {
      dlog('heartbeat erro', err);
    }
  }

  // ─── Máquina de estados ──────────────────────────────────────────

  function armWatchAfterSend() {
    state.phase = 'watch';
    state.sawStreaming = false;
    state.stableTicks = 0;
    state.replyStableSince = 0;
    state.lastReplySig = getLastReplySignature();
    // Baseline null → o tick registra a contagem ~1,5s após o envio, quando
    // nossa própria mensagem já entrou no DOM (ela pode conter o marcador).
    resetMarkerCounters();
  }

  async function onGenerationEnded(reason) {
    if (!state.armed || state.pendingSend) return;
    if (state.phase === 'idle') return;

    // Evita reagir imediatamente após o nosso próprio send
    if (Date.now() - state.lastSendAt < 2500) return;
    // Backoff após falha de inserção (comum com aba/minimizado em segundo plano)
    if (Date.now() - state.lastSendAttemptAt < SEND_RETRY_MS) return;

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

      if (markerActive() && state.markerBaseline !== null) {
        const c = countMarker();
        if (state.maxTotal >= 1 && c >= state.maxTotal) {
          dlog('marcador: máximo total atingido antes do envio', { c, max: state.maxTotal });
          stop();
          setStatus(
            `⚠️ <strong>Limite máximo atingido</strong>: ${c}/${state.maxTotal} ` +
              `ocorrências de "${escapeHtml(state.marker)}" na página. Execução parada.`
          );
          return;
        }
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

      const text = state.text;
      state.lastSendAttemptAt = Date.now();
      const sent = await sendMessage(text);
      if (sent) {
        state.remaining -= 1;
        persistUiFields();
        if (state.remaining <= 0) {
          state.finishing = true;
          armWatchAfterSend();
          setStatus('Última inserção enviada. Aguardando a IA terminar a resposta…');
        } else {
          armWatchAfterSend();
          setStatus(`Enviado. Aguardando próxima resposta… (${restHtml()})`);
        }
      } else {
        dlog('onGenerationEnded: envio falhou — reagendando (background?)', {
          hidden: pageLikelyBackgrounded(),
        });
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
      state.phase = 'watch';
      state.sawStreaming = true;
    } finally {
      state.pendingSend = false;
      state.pendingSendSince = 0;
      updateFab();
    }
  }

  /**
   * Modo contagem: conta ocorrências do marcador; envia quando o total de
   * NOVAS ocorrências desde o último envio atingir o mínimo E a contagem
   * parar de crescer (IA parou de inserir texto de resposta).
   */
  function markerTick(elapsed) {
    const current = countMarker();

    // Limite máximo TOTAL na página: ao atingir, para tudo com aviso.
    if (state.maxTotal >= 1 && current >= state.maxTotal) {
      dlog('marcador: máximo total atingido', { current, max: state.maxTotal });
      stop();
      setStatus(
        `⚠️ <strong>Limite máximo atingido</strong>: ${current}/${state.maxTotal} ` +
          `ocorrências de "${escapeHtml(state.marker)}" na página. Execução parada.`
      );
      return;
    }

    // Registra a baseline (contagem atual) ~1,5s após o envio.
    if (state.markerBaseline === null) {
      if (elapsed >= 1500) {
        state.markerBaseline = current;
        state.markerLast = current;
        state.markerStableTicks = 0;
        state.markerStableSince = Date.now();
        dlog('marcador: baseline =', current);
        setStatus(
          `Base: <strong>${current}</strong> ocorrência(s) de "${escapeHtml(state.marker)}". Monitorando novas… (${restHtml()})`
        );
      }
      return;
    }

    if (current > state.markerLast) {
      state.markerLast = current;
      state.markerStableTicks = 0;
      state.markerStableSince = 0;
      state.sawStreaming = true;
      state.phase = 'streaming';
    } else {
      state.markerStableTicks += 1;
      if (!state.markerStableSince) state.markerStableSince = Date.now();
    }

    const news = state.markerLast - state.markerBaseline;
    // Wall-clock: funciona mesmo com setInterval throttled (aba/minimizado).
    const stable = markerStableFor(STABLE_MS) || state.markerStableTicks >= 6;
    const gen = hasHardStreamingSignal();

    if (gen) {
      setStatus(
        `IA gerando… novas: <strong>${news}/${state.minNew}</strong> (${restHtml()})`
      );
      return;
    }

    // 1º envio com chat parado: nada cresceu desde o início e sem geração.
    const isFirstSend = state.remaining === state.times;
    const firstStable =
      markerStableFor(FIRST_SEND_STABLE_MS) || state.markerStableTicks >= 12;
    if (isFirstSend && news === 0 && firstStable && elapsed >= 4000) {
      dlog('marcador: chat parado — 1º envio imediato');
      void onGenerationEnded('chat parado, 1º envio');
      return;
    }

    if (news >= state.minNew && stable && elapsed >= 4000) {
      dlog('marcador: mínimo atingido e contagem estável', {
        news,
        min: state.minNew,
        stableTicks: state.markerStableTicks,
        stableMs: state.markerStableSince
          ? Date.now() - state.markerStableSince
          : 0,
      });
      void onGenerationEnded(`${news}/${state.minNew} novas e estável`);
      return;
    }

    setStatus(
      `Novas ocorrências: <strong>${news}/${state.minNew}</strong>` +
        (state.maxTotal >= 1 ? ` · total ${current}/${state.maxTotal}` : '') +
        (news >= state.minNew
          ? ' · mínimo atingido, aguardando parar de crescer'
          : '') +
        ` (${restHtml()})`
    );
  }

  function tick() {
    updateCountLine();
    updateTimerLine();

    if (!state.armed || state.pendingSend) return;
    if (!state.finishing && state.remaining <= 0) return;
    if (state.phase === 'idle') return;

    const elapsed = Date.now() - state.lastSendAt;

    if (markerActive()) {
      markerTick(elapsed);
      return;
    }

    // Estabilidade do texto ANTES de isGenerating(): ela destrava sinais
    // fracos presos (blocos de thinking de respostas já concluídas).
    if (elapsed >= 1500) {
      const sig = getLastReplySignature();
      if (sig && sig === state.lastReplySig) {
        state.stableTicks += 1;
        if (!state.replyStableSince) state.replyStableSince = Date.now();
      } else {
        state.lastReplySig = sig;
        state.stableTicks = 0;
        state.replyStableSince = 0;
        if (sig) state.sawStreaming = true;
      }
    }

    const gen = isGenerating();

    if (gen) {
      state.sawStreaming = true;
      state.phase = 'streaming';
      setStatus(`IA gerando… (${restHtml()})`);
      return;
    }

    const sendReady = isSendButtonReady();
    const stableEnough = replyStableFor(2000) || state.stableTicks >= 5;
    const finishedByStop =
      state.sawStreaming && state.phase === 'streaming' && !gen && elapsed >= 2500;
    // Não exige sendReady: ChatGPT com composer vazio mostra o botão de voz,
    // então o send-button não existe mesmo com a IA parada.
    const finishedByStable = state.sawStreaming && stableEnough && elapsed >= 4000;
    const finishedBySendBack =
      state.sawStreaming &&
      sendReady &&
      elapsed >= 3000 &&
      !gen &&
      state.phase === 'streaming';

    if (finishedByStop || finishedBySendBack) {
      dlog('fim detectado:', finishedByStop ? 'stop sumiu' : 'send voltou', {
        elapsed,
        stableTicks: state.stableTicks,
        stableMs: state.replyStableSince ? Date.now() - state.replyStableSince : 0,
      });
      void onGenerationEnded(finishedByStop ? 'stop sumiu' : 'send voltou');
      return;
    }
    if (finishedByStable) {
      dlog('fim detectado: texto estável', {
        elapsed,
        stableTicks: state.stableTicks,
        stableMs: state.replyStableSince ? Date.now() - state.replyStableSince : 0,
      });
      void onGenerationEnded('texto estável');
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
    const el = card.querySelector('.project-button-title');
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isNotebookPinned(card) {
    if (card.querySelector('.project-action-pin-icon')) return true;
    const pin = card.querySelector(
      '[aria-label*="fixado" i], [aria-label*="pinned" i], [mattooltip*="Fixado" i], [mattooltip*="Pinned" i]'
    );
    return !!pin;
  }

  function titleIsProtected(title, protectList) {
    if (!title || !protectList.length) return false;
    const lower = title.toLowerCase();
    return protectList.some((p) => lower.includes(p.toLowerCase()));
  }

  /** Cards de notebook elegíveis para exclusão (não fixados e sem texto protetor). */
  function findDeletableNotebooks(protectList, skipTitles) {
    const skipped = skipTitles || new Set();
    return Array.from(document.querySelectorAll('project-button.project-button')).filter(
      (card) => {
        if (card.closest('#cca-root')) return false;
        if (card.dataset.ccaSkipDelete === '1') return false;
        if (isNotebookPinned(card)) return false;
        const title = notebookTitle(card);
        if (!title) return false;
        if (skipped.has(title.toLowerCase())) return false;
        if (titleIsProtected(title, protectList)) return false;
        const more = findNotebookMoreButton(card);
        return !!more;
      }
    );
  }

  function findNotebookMoreButton(card) {
    return (
      card.querySelector('button.project-button-more') ||
      card.querySelector(
        'button[aria-label*="ações do projeto" i], button[aria-label*="Project Actions" i], button[aria-label*="More options" i], button[aria-label*="Mais opções" i]'
      )
    );
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
      /desafixar|unpin|renomear|rename|compartilh|share|abrir|open|mover|move|copiar|copy/.test(
        t
      )
    ) {
      return false;
    }
    // "Fixar"/"Pin" sozinhos não são exclusão.
    if (/^(fixar|pin|unpin|keep)$/.test(t)) return false;
    return /exclu|delete|apagar|remover notebook|delete notebook|remove notebook/.test(t);
  }

  function findOpenDeleteMenuItem() {
    const items = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], button.mat-mdc-menu-item, .mat-mdc-menu-item'
      )
    );
    // Não exige visible() estrito: o painel do menu Angular às vezes reporta 0x0 no 1º frame.
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
          document.querySelectorAll('project-button.project-button .project-button-title')
        ).some((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === title);
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
    const preview = findDeletableNotebooks(protectList, skipTitles);
    if (!preview.length) {
      setStatus(
        'Nenhum notebook elegível: todos estão fixados, protegidos pelo texto do título, ou não há cards.'
      );
      return;
    }

    const sample = preview
      .slice(0, 5)
      .map((c) => notebookTitle(c))
      .join(' · ');
    const ok = window.confirm(
      `Excluir ${preview.length} notebook(s) não fixado(s)?\n\n` +
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
    state.stopTextBaseline = null;
    disconnectArmedKeepalive();
    stopTimer();
    updateFab();
    setStatus(`Concluído. IA terminou a última resposta (${reason}).`);
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
    const total = countMarker();
    let txt = `"${state.marker}" na página: ${total}`;
    if (state.maxTotal >= 1) txt += ` / máx ${state.maxTotal}`;
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
    const maxEl = rootEl?.querySelector('#cca-max');
    const stopEl = rootEl?.querySelector('#cca-stop-text');
    const protectEl = rootEl?.querySelector('#cca-protect-titles');
    if (textEl) state.text = textEl.value;
    if (timesEl) state.times = Math.max(1, parseInt(timesEl.value, 10) || 1);
    if (markerEl) state.marker = markerEl.value;
    if (minEl) state.minNew = Math.max(1, parseInt(minEl.value, 10) || 1);
    if (maxEl) state.maxTotal = Math.max(0, parseInt(maxEl.value, 10) || 0);
    if (stopEl) state.stopText = stopEl.value;
    if (protectEl) state.protectTitles = protectEl.value;
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          text: state.text,
          savedTexts: state.savedTexts,
          times: state.times,
          marker: state.marker,
          minNew: state.minNew,
          maxTotal: state.maxTotal,
          stopText: state.stopText,
          protectTitles: state.protectTitles,
          nlmSectionOpen: state.nlmSectionOpen,
        },
      });
    } catch {
      // storage indisponível
    }
  }

  function updateSaveTextButton() {
    const textEl = rootEl?.querySelector('#cca-text');
    const saveBtn = rootEl?.querySelector('#cca-save-text');
    if (!textEl || !saveBtn) return;
    const text = textEl.value.trim();
    const alreadySaved = !!text && state.savedTexts.includes(text);
    saveBtn.disabled = !text || alreadySaved;
    saveBtn.textContent = alreadySaved ? 'Já salvo' : 'Salvar texto atual';
    saveBtn.title = !text
      ? 'Digite um texto antes de salvar.'
      : alreadySaved
        ? 'Este texto já está salvo.'
        : 'Adicionar o texto atual à lista de textos salvos.';
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

    state.savedTexts.forEach((text, index) => {
      const row = document.createElement('div');
      row.className = 'cca-saved-row';
      row.setAttribute('role', 'listitem');

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'cca-saved-select';
      selectBtn.dataset.savedTextIndex = String(index);
      selectBtn.title = 'Usar este texto';
      selectBtn.textContent = text;

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
    if (!textEl) return;
    const text = textEl.value.trim();
    if (!text || state.savedTexts.includes(text)) {
      updateSaveTextButton();
      return;
    }
    textEl.value = text;
    state.text = text;
    state.savedTexts.unshift(text);
    persistUiFields();
    renderSavedTexts();
  }

  function selectSavedText(index) {
    const text = state.savedTexts[index];
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
    state.lastSendAttemptAt = Date.now();
    setStatus(`Chat parado — enviando agora… (restam <strong>${total}</strong>)`);
    try {
      const sent = await sendMessage(state.text);
      if (sent) {
        state.remaining -= 1;
        if (state.remaining <= 0) {
          state.finishing = true;
          armWatchAfterSend();
          setStatus('Última inserção enviada. Aguardando a IA terminar a resposta…');
        } else {
          armWatchAfterSend();
          setStatus(`Enviado. Aguardando a IA terminar… (${restHtml()})`);
        }
      } else {
        dlog('sendFirstNow: falhou — reagendando', { hidden: pageLikelyBackgrounded() });
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
      state.phase = 'watch';
      state.sawStreaming = true;
    } finally {
      state.pendingSend = false;
      state.pendingSendSince = 0;
      updateFab();
    }
  }

  function start() {
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
    state.stableTicks = 0;
    state.replyStableSince = 0;
    state.sawStreaming = false;
    state.lastSendAttemptAt = 0;
    state.stopTextBaseline = stopTextActive() ? countStopText() : null;
    connectArmedKeepalive();
    startTimer();
    updateFab();

    if (markerActive()) {
      // Modo contagem: registra a base e monitora novas ocorrências;
      // o 1º envio sai quando a contagem estabilizar (ou logo, se parado).
      const gen = isGenerating();
      state.phase = gen ? 'streaming' : 'watch';
      state.sawStreaming = gen;
      state.lastSendAt = Date.now() - 5000;
      state.lastReplySig = getLastReplySignature();
      resetMarkerCounters();
      setStatus(
        `Ativo (modo contagem de "${escapeHtml(state.marker)}"). Registrando base… (restam <strong>${n}</strong>)`
      );
    } else if (isGenerating()) {
      state.phase = 'streaming';
      state.sawStreaming = true;
      state.lastSendAt = Date.now() - 5000; // permite disparar ao terminar a resposta atual
      state.lastReplySig = getLastReplySignature();
      setStatus(`Ativo. Aguardando a IA terminar… (restam <strong>${n}</strong>)`);
    } else {
      // Chat parado: inserir texto + Enter imediatamente.
      state.phase = 'idle';
      void sendFirstNow(n);
    }
  }

  function stop() {
    state.armed = false;
    state.finishing = false;
    state.remaining = 0;
    state.pendingSend = false;
    state.pendingSendSince = 0;
    state.phase = 'idle';
    state.sawStreaming = false;
    state.stopTextBaseline = null;
    disconnectArmedKeepalive();
    stopTimer();
    setStatus('Parado.');
    updateFab();
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
    setPanelOpen(true);
  }

  function buildUi() {
    const existing = document.getElementById('cca-root');
    if (existing) {
      rootEl = existing;
      statusEl = rootEl.querySelector('#cca-status');
      fabEl = rootEl.querySelector('#cca-fab');
      return;
    }

    rootEl = document.createElement('div');
    rootEl.id = 'cca-root';
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
              <strong>Textos salvos</strong>
              <button type="button" id="cca-save-text">Salvar texto atual</button>
            </div>
            <div id="cca-saved-text-list" role="list"></div>
          </div>
        </div>
        <label for="cca-marker" title="Texto/marcador esperado na resposta da IA para contar novas ocorrências (ex.: =ff=). Deixe em branco para modo automático.">String de resposta da IA (modo contagem) <span class="cca-info" title="Texto/marcador esperado na resposta da IA para contar novas ocorrências (ex.: =ff=). Deixe em branco para modo automático.">ⓘ</span></label>
        <input id="cca-marker" type="text" spellcheck="false"
          placeholder='ex.: uma string que aparece nas respostas'
          title="Texto/marcador esperado na resposta da IA para contar novas ocorrências (ex.: =ff=). Deixe em branco para modo automático." />
        <div id="cca-row">
          <div>
            <label for="cca-times" title="Quantidade total de vezes que a mensagem será inserida e enviada no chat (padrão: 100).">Quantas vezes <span class="cca-info" title="Quantidade total de vezes que a mensagem será inserida e enviada no chat (padrão: 100).">ⓘ</span></label>
            <input id="cca-times" type="number" min="1" max="9999" step="1" title="Quantidade total de vezes que a mensagem será inserida e enviada no chat (padrão: 100)." />
          </div>
          <div>
            <label for="cca-min" title="Quantidade mínima de novas aparições do marcador na página para autorizar o próximo envio.">Mín. novas ocorrências <span class="cca-info" title="Quantidade mínima de novas aparições do marcador na página para autorizar o próximo envio.">ⓘ</span></label>
            <input id="cca-min" type="number" min="1" max="999" step="1" title="Quantidade mínima de novas aparições do marcador na página para autorizar o próximo envio." />
          </div>
        </div>
        <label for="cca-max" title="Limite máximo acumulado da string de resposta na página. Ao atingir este número, as inserções são interrompidas (padrão: 100; 0 = sem limite).">Máx. total da string na página (0 = sem limite) <span class="cca-info" title="Limite máximo acumulado da string de resposta na página. Ao atingir este número, as inserções são interrompidas (padrão: 100; 0 = sem limite).">ⓘ</span></label>
        <input id="cca-max" type="number" min="0" max="9999" step="1" title="Limite máximo acumulado da string de resposta na página. Ao atingir este número, as inserções são interrompidas (padrão: 100; 0 = sem limite)." />
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
              Preserva notebooks fixados (ícone de alfinete) e os cujo título
              contenha qualquer texto do campo acima. Use na página inicial
              do NotebookLM. Continua mesmo com o navegador em segundo plano.
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
          Com a string de resposta preenchida, o envio só ocorre quando surgirem
          pelo menos N novas ocorrências dela na página E a contagem parar de
          crescer. Deixe vazia para usar a detecção automática. O texto de
          parada só é verificado depois que a IA termina a resposta e deve estar
          presente nessa resposta concluída.
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
    const maxEl = rootEl.querySelector('#cca-max');
    const stopEl = rootEl.querySelector('#cca-stop-text');
    const protectEl = rootEl.querySelector('#cca-protect-titles');
    const nlmSection = rootEl.querySelector('#cca-nlm-section');

    textEl.value = state.text;
    timesEl.value = String(state.times);
    markerEl.value = state.marker;
    minEl.value = String(state.minNew);
    maxEl.value = String(state.maxTotal);
    stopEl.value = state.stopText;
    if (protectEl) protectEl.value = state.protectTitles;
    if (nlmSection) {
      nlmSection.style.display = isNotebookLM() ? '' : 'none';
      nlmSection.dataset.open = state.nlmSectionOpen ? '1' : '0';
    }
    renderSavedTexts();

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
    const persistEls = [textEl, timesEl, markerEl, minEl, maxEl, stopEl];
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
        state.savedTexts = Array.isArray(s.savedTexts)
          ? normalizeSavedTexts(s.savedTexts)
          : [...DEFAULTS.savedTexts];
        state.times =
          Number.isFinite(s.times) && s.times !== LEGACY_DEFAULT_TIMES && s.times >= 1
            ? s.times
            : DEFAULTS.times;
        state.marker =
          typeof s.marker === 'string' && s.marker.trim() ? s.marker : DEFAULTS.marker;
        state.minNew =
          Number.isFinite(s.minNew) && s.minNew >= 1 ? s.minNew : DEFAULTS.minNew;
        state.maxTotal =
          Number.isFinite(s.maxTotal) && s.maxTotal !== LEGACY_DEFAULT_MAX_TOTAL && s.maxTotal >= 0
            ? s.maxTotal
            : DEFAULTS.maxTotal;
        state.stopText =
          typeof s.stopText === 'string' ? s.stopText : DEFAULTS.stopText;
        state.protectTitles =
          typeof s.protectTitles === 'string' ? s.protectTitles : DEFAULTS.protectTitles;
        state.nlmSectionOpen =
          typeof s.nlmSectionOpen === 'boolean' ? s.nlmSectionOpen : DEFAULTS.nlmSectionOpen;
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
    if (msg?.type === 'cca-open-panel' || msg?.type === 'cca-toggle-panel') {
      if (!rootEl) buildUi();
      if (msg.type === 'cca-open-panel') openPanel();
      else togglePanel();
      sendResponse({ ok: true, open: state.panelOpen });
      return true;
    }
    return false;
  });

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
