(() => {
  'use strict';

  // Evita UI/interval duplicados se o background reinjetar o script.
  if (window.__CCA_LOADED__) {
    window.dispatchEvent(new CustomEvent('cca-reopen'));
    return;
  }
  window.__CCA_LOADED__ = true;

  const STORAGE_KEY = 'cca_settings';
  const DEFAULTS = {
    text: 'execute o comando',
    times: 4,
    /** String que identifica texto de resposta da IA (modo contagem). */
    marker: '=ff=',
    /** Mínimo de NOVAS ocorrências do marcador antes de enviar. */
    minNew: 1,
    /** Máximo TOTAL de ocorrências na página — ao atingir, para (0 = sem limite). */
    maxTotal: 0,
    /** Texto que, ao surgir na conversa, encerra as inserções. */
    stopText: 'COMANDO FINALIZADO',
  };
  /** Default antigo — migra para o novo se o usuário nunca personalizou. */
  const LEGACY_DEFAULT_TEXT = 'continue';

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

  const state = {
    armed: false,
    remaining: 0,
    text: DEFAULTS.text,
    times: DEFAULTS.times,
    /** idle | watch | streaming */
    phase: 'idle',
    pendingSend: false,
    lastSendAt: 0,
    /** Última tentativa de envio (sucesso ou falha) — para backoff. */
    lastSendAttemptAt: 0,
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
    /** Texto de parada: ao surgir na conversa, não insere mais. */
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
  };

  let rootEl = null;
  let statusEl = null;
  let fabEl = null;
  /** Porta longa com o SW enquanto armado (evita throttle de aba em background). */
  let armedPort = null;
  let armedPortRetryTimer = null;

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

  /** Texto da última bolha do assistente — para detectar quando parou de crescer. */
  function getLastReplySignature() {
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
      const t = (el.innerText || '').trim();
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
      armedPort.onDisconnect.addListener(() => {
        armedPort = null;
        if (!state.armed) return;
        // SW reiniciou — reconecta para o poller voltar.
        if (armedPortRetryTimer) clearTimeout(armedPortRetryTimer);
        armedPortRetryTimer = setTimeout(() => {
          armedPortRetryTimer = null;
          if (state.armed) connectArmedKeepalive();
        }, 400);
      });
      dlog('keepalive: conectado ao service worker');
    } catch (err) {
      dlog('keepalive: falha ao conectar', err);
      armedPort = null;
    }
  }

  function disconnectArmedKeepalive() {
    if (armedPortRetryTimer) {
      clearTimeout(armedPortRetryTimer);
      armedPortRetryTimer = null;
    }
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
   * Se o texto de parada surgiu na conversa desde o Iniciar, encerra as
   * inserções e retorna true. Caso contrário, false.
   */
  function checkStopTextAndHalt() {
    if (!stopTextActive() || !state.armed) return false;
    const current = countStopText();
    if (state.stopTextBaseline === null) {
      state.stopTextBaseline = current;
      return false;
    }
    if (current <= state.stopTextBaseline) return false;
    dlog('texto de parada detectado', {
      text: state.stopText,
      baseline: state.stopTextBaseline,
      current,
    });
    stop();
    setStatus(
      `🛑 <strong>Texto de parada encontrado</strong>: "${escapeHtml(state.stopText)}". ` +
        `Inserções encerradas.`
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

  async function sendMessage(text) {
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

    const sendBtn = findSendButton();
    dlog('sendMessage: inserido OK; sendBtn =', sendBtn ? 'achado' : 'não achado');
    if (sendBtn) {
      sendBtn.click();
      state.lastSendAt = Date.now();
      return true;
    }

    pressEnter(composer);
    await sleep(200);
    const retry = findSendButton();
    if (retry) {
      retry.click();
      state.lastSendAt = Date.now();
      return true;
    }

    // Texto entrou; Enter pode ter bastado mesmo sem achar o botão.
    state.lastSendAt = Date.now();
    setStatus('Texto inserido. Se não enviou sozinho, pressione Enter no chat.');
    return true;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

    if (checkStopTextAndHalt()) return;

    // Modo finalização: a última inserção já foi enviada. Ao detectar que a IA
    // terminou de responder a ela, encerra (para timer/contagens) sem reenviar.
    if (state.finishing) {
      dlog('onGenerationEnded (finalizando):', reason, '— confirmando fim');
      state.pendingSend = true;
      state.phase = 'idle';
      setStatus(`IA finalizando a última resposta (${reason})… confirmando.`);

      await sleep(AFTER_IDLE_MS);

      if (!state.armed) {
        state.pendingSend = false;
        return;
      }
      if (isGenerating()) {
        state.pendingSend = false;
        state.phase = 'streaming';
        state.sawStreaming = true;
        setStatus('Geração retomou — aguardando parar de novo.');
        return;
      }
      // Modo contagem: novas ocorrências durante a espera → segue aguardando.
      if (markerActive() && state.markerBaseline !== null) {
        const c = countMarker();
        if (c > state.markerLast) {
          state.markerLast = c;
          state.markerStableTicks = 0;
          state.markerStableSince = 0;
          state.pendingSend = false;
          state.phase = 'streaming';
          state.sawStreaming = true;
          setStatus('Novas ocorrências surgiram — aguardando estabilizar.');
          return;
        }
      }
      finishRun(reason);
      return;
    }

    if (state.remaining <= 0) return;

    dlog('onGenerationEnded:', reason, '— enviando após delay');
    state.pendingSend = true;
    state.phase = 'idle'; // trava reentrância até o próximo send
    setStatus(
      `IA parou (${reason}). Enviando em ${AFTER_IDLE_MS / 1000}s… (${restHtml()})`
    );

    await sleep(AFTER_IDLE_MS);

    if (!state.armed || state.remaining <= 0) {
      state.pendingSend = false;
      return;
    }

    if (checkStopTextAndHalt()) {
      state.pendingSend = false;
      return;
    }

    if (isGenerating()) {
      state.pendingSend = false;
      state.phase = 'streaming';
      state.sawStreaming = true;
      setStatus('Geração retomou — aguardando parar de novo.');
      return;
    }

    // Modo contagem: se surgiram ocorrências novas durante a espera, aborta.
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
        state.pendingSend = false;
        state.phase = 'streaming';
        state.sawStreaming = true;
        setStatus('Novas ocorrências surgiram durante a espera — aguardando estabilizar.');
        return;
      }
    }

    const text = state.text;
    state.lastSendAttemptAt = Date.now();
    const sent = await sendMessage(text);
    if (sent) {
      state.remaining -= 1;
      persistUiFields();
      if (state.remaining <= 0) {
        // Última inserção enviada: não encerra ainda. Aguarda a IA terminar
        // esta resposta (e atingir a ocorrência mínima da string), como se
        // ainda houvesse uma inserção pela frente. O timer segue rodando.
        state.finishing = true;
        armWatchAfterSend();
        setStatus('Última inserção enviada. Aguardando a IA terminar a resposta…');
      } else {
        armWatchAfterSend();
        setStatus(
          `Enviado. Aguardando próxima resposta… (${restHtml()})`
        );
      }
    } else {
      // Não desarma: com o navegador minimizado/outra aba o focus() pode falhar.
      // Mantém armado e reabre a janela de observação para tentar de novo.
      dlog('onGenerationEnded: envio falhou — reagendando (background?)', {
        hidden: pageLikelyBackgrounded(),
      });
      state.phase = 'watch';
      state.sawStreaming = true;
      // Força nova estabilização curta antes do próximo disparo.
      state.markerStableTicks = 0;
      if (state.markerStableSince) state.markerStableSince = Date.now();
      state.replyStableSince = 0;
      state.stableTicks = 0;
      setStatus(
        pageLikelyBackgrounded()
          ? `Falha ao enviar (navegador em segundo plano). Continuando a tentar… (${restHtml()})`
          : `Falha ao enviar. Continuando a tentar… (${restHtml()})`
      );
    }
    state.pendingSend = false;
    updateFab();
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

    if (checkStopTextAndHalt()) return;

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
    fabEl.dataset.active = state.armed ? '1' : '0';
    fabEl.title = state.armed
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
    if (textEl) state.text = textEl.value;
    if (timesEl) state.times = Math.max(1, parseInt(timesEl.value, 10) || 1);
    if (markerEl) state.marker = markerEl.value;
    if (minEl) state.minNew = Math.max(1, parseInt(minEl.value, 10) || 1);
    if (maxEl) state.maxTotal = Math.max(0, parseInt(maxEl.value, 10) || 0);
    if (stopEl) state.stopText = stopEl.value;
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          text: state.text,
          times: state.times,
          marker: state.marker,
          minNew: state.minNew,
          maxTotal: state.maxTotal,
          stopText: state.stopText,
        },
      });
    } catch {
      // storage indisponível
    }
  }

  async function sendFirstNow(total) {
    state.pendingSend = true;
    state.lastSendAttemptAt = Date.now();
    setStatus(`Chat parado — enviando agora… (restam <strong>${total}</strong>)`);
    const sent = await sendMessage(state.text);
    if (sent) {
      state.remaining -= 1;
      if (state.remaining <= 0) {
        // Última inserção enviada: aguarda a IA terminar esta resposta antes
        // de encerrar (timer e contagens seguem rodando).
        state.finishing = true;
        armWatchAfterSend();
        setStatus('Última inserção enviada. Aguardando a IA terminar a resposta…');
      } else {
        armWatchAfterSend();
        setStatus(
          `Enviado. Aguardando a IA terminar… (${restHtml()})`
        );
      }
    } else {
      // Mantém armado e tenta de novo via tick (útil com navegador minimizado).
      dlog('sendFirstNow: falhou — reagendando', { hidden: pageLikelyBackgrounded() });
      state.phase = 'watch';
      state.sawStreaming = false;
      state.lastSendAt = Date.now() - 5000;
      resetMarkerCounters();
      setStatus(
        pageLikelyBackgrounded()
          ? `Falha ao enviar (navegador em segundo plano). Continuando a tentar… (restam <strong>${total}</strong>)`
          : `Falha ao enviar. Continuando a tentar… (restam <strong>${total}</strong>)`
      );
    }
    state.pendingSend = false;
    updateFab();
  }

  function start() {
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
        <label for="cca-text">Texto a inserir após a IA terminar</label>
        <textarea id="cca-text" spellcheck="false"></textarea>
        <label for="cca-marker">String de resposta da IA (modo contagem)</label>
        <input id="cca-marker" type="text" spellcheck="false"
          placeholder='ex.: uma string que aparece nas respostas' />
        <div id="cca-row">
          <div>
            <label for="cca-times">Quantas vezes</label>
            <input id="cca-times" type="number" min="1" max="99" step="1" />
          </div>
          <div>
            <label for="cca-min">Mín. novas ocorrências</label>
            <input id="cca-min" type="number" min="1" max="999" step="1" />
          </div>
        </div>
        <label for="cca-max">Máx. total da string na página (0 = sem limite)</label>
        <input id="cca-max" type="number" min="0" max="9999" step="1" />
        <label for="cca-stop-text">Texto de parada (encerra ao surgir na conversa)</label>
        <input id="cca-stop-text" type="text" spellcheck="false"
          placeholder="ex.: COMANDO FINALIZADO" />
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
          crescer. Deixe vazia para usar a detecção automática. Se o texto de
          parada surgir na conversa, as inserções são encerradas imediatamente.
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

    textEl.value = state.text;
    timesEl.value = String(state.times);
    markerEl.value = state.marker;
    minEl.value = String(state.minNew);
    maxEl.value = String(state.maxTotal);
    stopEl.value = state.stopText;

    fabEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    rootEl.querySelector('#cca-start').addEventListener('click', start);
    rootEl.querySelector('#cca-stop').addEventListener('click', stop);
    for (const el of [textEl, timesEl, markerEl, minEl, maxEl, stopEl]) {
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
        if (saved && saved !== LEGACY_DEFAULT_TEXT) state.text = saved;
        else state.text = DEFAULTS.text;
        state.times = Number.isFinite(s.times) && s.times >= 1 ? s.times : DEFAULTS.times;
        state.marker =
          typeof s.marker === 'string' && s.marker.trim() ? s.marker : DEFAULTS.marker;
        state.minNew =
          Number.isFinite(s.minNew) && s.minNew >= 1 ? s.minNew : DEFAULTS.minNew;
        state.maxTotal =
          Number.isFinite(s.maxTotal) && s.maxTotal >= 0 ? s.maxTotal : DEFAULTS.maxTotal;
        state.stopText =
          typeof s.stopText === 'string' ? s.stopText : DEFAULTS.stopText;
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
      // Poller do service worker (não throttled como setInterval na aba oculta).
      try {
        tick();
      } catch (err) {
        dlog('cca-tick erro', err);
      }
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
    if (!state.armed) return;
    dlog('visibility: aba visível de novo — tick imediato');
    try {
      tick();
    } catch (err) {
      dlog('visibility tick erro', err);
    }
  });

  loadSettings(() => {
    buildUi();
    setInterval(tick, POLL_MS);
  });
})();
