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
  };
  /** Default antigo — migra para o novo se o usuário nunca personalizou. */
  const LEGACY_DEFAULT_TEXT = 'continue';

  /** Delay após a IA parar, antes de digitar (UI estabilizar). */
  const AFTER_IDLE_MS = 1200;
  /** Delay entre digitar e enviar. */
  const BEFORE_SEND_MS = 250;
  /** Polling de estado gerando/idle. */
  const POLL_MS = 400;

  const state = {
    armed: false,
    remaining: 0,
    text: DEFAULTS.text,
    times: DEFAULTS.times,
    /** idle | watch | streaming */
    phase: 'idle',
    pendingSend: false,
    lastSendAt: 0,
    panelOpen: false,
    /** Assinatura da última resposta (tamanho) para detectar estabilização. */
    lastReplySig: '',
    stableTicks: 0,
    sawStreaming: false,
  };

  let rootEl = null;
  let statusEl = null;
  let fabEl = null;

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
      'button[aria-label="Parar"]',
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
        t.includes('parar de gerar')
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

  function hasStreamingIndicator() {
    const sels = [
      '.result-streaming',
      '[data-is-streaming="true"]',
      '.result-streaming[aria-busy="true"]',
      '[aria-busy="true"].result-streaming',
      '[data-testid*="thinking"]',
      '[data-testid*="reasoning"]',
      'button[data-testid="stop-button"]',
    ];
    for (const sel of sels) {
      if (document.querySelector(sel)) return true;
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
    if (findStopButton()) return true;
    if (hasStreamingIndicator()) return true;
    // ChatGPT: enquanto gera, o send-button some; após nosso envio isso conta.
    if (
      state.phase !== 'idle' &&
      Date.now() - state.lastSendAt > 600 &&
      Date.now() - state.lastSendAt < 30 * 60 * 1000
    ) {
      const send = document.querySelector('button[data-testid="send-button"]');
      const stop = document.querySelector('button[data-testid="stop-button"]');
      if (stop) return true;
      // Sem send e sem stop ainda pode ser "thinking" — trata como gerando se vimos stream ou acabamos de enviar
      if (!send && state.sawStreaming) return true;
    }
    return false;
  }

  /** Texto da última bolha do assistente — para detectar quando parou de crescer. */
  function getLastReplySignature() {
    const groups = [
      document.querySelectorAll('[data-message-author-role="assistant"]'),
      document.querySelectorAll('[data-turn="assistant"]'),
      document.querySelectorAll('section[data-turn="assistant"]'),
      document.querySelectorAll('.font-claude-message'),
    ];
    for (const list of groups) {
      if (!list.length) continue;
      const el = list[list.length - 1];
      if (!el || el.closest('#cca-root')) continue;
      const t = (el.innerText || '').trim();
      if (t) return `${t.length}:${t.slice(-80)}`;
    }
    return '';
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
      setStatus('Não achei o campo de mensagem nesta página.');
      return false;
    }

    setStatus(`Campo achado (<code>${composer.id || composer.tagName}</code>). Inserindo…`);
    const ok = setComposerText(composer, text);
    if (!ok) {
      setStatus(
        'Achei o campo, mas o site bloqueou a inserção. Clique uma vez no input do chat e tente Iniciar de novo.'
      );
      return false;
    }

    await sleep(BEFORE_SEND_MS);

    const sendBtn = findSendButton();
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
    state.lastReplySig = getLastReplySignature();
  }

  async function onGenerationEnded(reason) {
    if (!state.armed || state.remaining <= 0 || state.pendingSend) return;
    if (state.phase === 'idle') return;

    // Evita reenvio imediato após o nosso próprio send
    if (Date.now() - state.lastSendAt < 2500) return;

    state.pendingSend = true;
    state.phase = 'idle'; // trava reentrância até o próximo send
    setStatus(
      `IA parou (${reason}). Enviando em ${AFTER_IDLE_MS / 1000}s… (restam <strong>${state.remaining}</strong>)`
    );

    await sleep(AFTER_IDLE_MS);

    if (!state.armed || state.remaining <= 0) {
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

    const text = state.text;
    const sent = await sendMessage(text);
    if (sent) {
      state.remaining -= 1;
      persistUiFields();
      if (state.remaining <= 0) {
        state.armed = false;
        state.phase = 'idle';
        setStatus('Concluído. Todas as inserções foram enviadas.');
      } else {
        armWatchAfterSend();
        setStatus(
          `Enviado. Aguardando próxima resposta… (restam <strong>${state.remaining}</strong>)`
        );
      }
    } else {
      state.armed = false;
      state.phase = 'idle';
    }
    state.pendingSend = false;
    updateFab();
  }

  function tick() {
    if (!state.armed || state.pendingSend || state.remaining <= 0) return;
    if (state.phase === 'idle') return;

    const gen = isGenerating();
    const elapsed = Date.now() - state.lastSendAt;

    if (gen) {
      state.sawStreaming = true;
      state.phase = 'streaming';
      state.stableTicks = 0;
      setStatus(`IA gerando… (restam <strong>${state.remaining}</strong>)`);
      return;
    }

    // Estabilidade do texto da resposta (fallback quando o botão Stop não aparece no DOM)
    if (elapsed >= 3000) {
      const sig = getLastReplySignature();
      if (sig && sig === state.lastReplySig) {
        state.stableTicks += 1;
      } else {
        state.lastReplySig = sig;
        state.stableTicks = 0;
        if (sig) state.sawStreaming = true;
      }
    }

    const sendReady = isSendButtonReady();
    const stableEnough = state.stableTicks >= 5; // ~2s com poll 400ms
    const finishedByStop =
      state.sawStreaming && state.phase === 'streaming' && !gen && elapsed >= 2500;
    const finishedByStable =
      state.sawStreaming && stableEnough && elapsed >= 4000 && (sendReady || !isChatGPT());
    const finishedBySendBack =
      state.sawStreaming &&
      sendReady &&
      elapsed >= 3000 &&
      !gen &&
      state.phase === 'streaming';

    if (finishedByStop || finishedBySendBack) {
      void onGenerationEnded(finishedByStop ? 'stop sumiu' : 'send voltou');
      return;
    }
    if (finishedByStable) {
      void onGenerationEnded('texto estável');
      return;
    }

    if (state.phase === 'watch') {
      setStatus(
        `Aguardando a IA gerar/terminar… (restam <strong>${state.remaining}</strong>)` +
          (state.sawStreaming ? ' · stream visto' : '')
      );
    } else if (state.phase === 'streaming' && !gen) {
      setStatus(
        `Confirmando fim da resposta… (${state.stableTicks}/5) · restam <strong>${state.remaining}</strong>`
      );
    }
  }

  // ─── UI ──────────────────────────────────────────────────────────

  function setStatus(html) {
    if (statusEl) statusEl.innerHTML = html;
  }

  function updateFab() {
    if (!fabEl) return;
    fabEl.dataset.active = state.armed ? '1' : '0';
    fabEl.title = state.armed
      ? `Ativo — restam ${state.remaining}`
      : 'Chat Continue Auto';
  }

  function persistUiFields() {
    const textEl = rootEl?.querySelector('#cca-text');
    const timesEl = rootEl?.querySelector('#cca-times');
    if (textEl) state.text = textEl.value;
    if (timesEl) state.times = Math.max(1, parseInt(timesEl.value, 10) || 1);
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: { text: state.text, times: state.times },
      });
    } catch {
      // storage indisponível
    }
  }

  async function sendFirstNow(total) {
    state.pendingSend = true;
    setStatus(`Chat parado — enviando agora… (restam <strong>${total}</strong>)`);
    const sent = await sendMessage(state.text);
    if (sent) {
      state.remaining -= 1;
      if (state.remaining <= 0) {
        state.armed = false;
        state.phase = 'idle';
        setStatus('Concluído. Todas as inserções foram enviadas.');
      } else {
        armWatchAfterSend();
        setStatus(
          `Enviado. Aguardando a IA terminar… (restam <strong>${state.remaining}</strong>)`
        );
      }
    } else {
      setStatus('Falha ao enviar. Confira o campo de mensagem do chat e tente de novo.');
      state.armed = false;
      state.remaining = 0;
      state.phase = 'idle';
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
    state.pendingSend = false;
    state.stableTicks = 0;
    state.sawStreaming = false;
    updateFab();

    if (isGenerating()) {
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
    state.remaining = 0;
    state.pendingSend = false;
    state.phase = 'idle';
    state.sawStreaming = false;
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
        <h2>Chat Continue Auto</h2>
        <label for="cca-text">Texto a inserir após a IA terminar</label>
        <textarea id="cca-text" spellcheck="false"></textarea>
        <div id="cca-row">
          <div>
            <label for="cca-times">Quantas vezes</label>
            <input id="cca-times" type="number" min="1" max="99" step="1" />
          </div>
        </div>
        <div id="cca-status">Configure e clique em Iniciar.</div>
        <div id="cca-actions">
          <button type="button" id="cca-start">Iniciar</button>
          <button type="button" id="cca-stop">Parar</button>
        </div>
        <p id="cca-hint">
          Com a IA idle, o 1º envio é imediato; os demais saem cada vez que ela
          terminar uma resposta. Clique no ícone flutuante (↻) ou no da extensão.
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

    textEl.value = state.text;
    timesEl.value = String(state.times);

    fabEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    rootEl.querySelector('#cca-start').addEventListener('click', start);
    rootEl.querySelector('#cca-stop').addEventListener('click', stop);
    textEl.addEventListener('input', persistUiFields);
    textEl.addEventListener('change', persistUiFields);
    timesEl.addEventListener('input', persistUiFields);
    timesEl.addEventListener('change', persistUiFields);
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

  loadSettings(() => {
    buildUi();
    setInterval(tick, POLL_MS);
  });
})();
