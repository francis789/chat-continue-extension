(() => {
  'use strict';

  const STORAGE_KEY = 'cca_settings';
  const DEFAULTS = {
    text: 'continue',
    times: 4,
  };

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
    wasGenerating: false,
    pendingSend: false,
    lastSendAt: 0,
    panelOpen: false,
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
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function queryAll(sel) {
    return Array.from(document.querySelectorAll(sel)).filter(visible);
  }

  function findStopButton() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Parar" i]',
      'button[aria-label*="Cancel" i]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop streaming" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop Response" i]',
    ];
    for (const sel of selectors) {
      const el = queryAll(sel)[0];
      if (el) return el;
    }
    // Fallback por texto do botão
    for (const btn of queryAll('button')) {
      const t = (btn.getAttribute('aria-label') || btn.textContent || '').trim().toLowerCase();
      if (
        t === 'stop' ||
        t === 'parar' ||
        t.includes('stop generating') ||
        t.includes('stop streaming') ||
        t.includes('stop response') ||
        t.includes('parar de gerar')
      ) {
        return btn;
      }
    }
    return null;
  }

  function isGenerating() {
    if (findStopButton()) return true;

    // ChatGPT: formulário com data-streaming / botão stop
    if (isChatGPT()) {
      if (document.querySelector('[data-testid="stop-button"]')) return true;
      if (document.querySelector('button.bg-black .text-white svg, button[aria-label="Stop streaming"]')) {
        return !!findStopButton();
      }
    }

    // Claude
    if (isClaude()) {
      if (document.querySelector('button[aria-label="Stop Response"], button[aria-label="Stop response"]')) {
        return true;
      }
    }

    // Gemini / AI Studio
    if (isGemini()) {
      if (document.querySelector('button[aria-label*="Stop" i], button.stop-button')) return true;
    }

    // DeepSeek
    if (isDeepSeek()) {
      if (document.querySelector('.ds-icon-button svg[class*="stop"], button[aria-label*="Stop" i]')) {
        return !!findStopButton() || !!document.querySelector('[class*="stop"]');
      }
    }

    return false;
  }

  function findComposer() {
    const candidates = [
      '#prompt-textarea',
      'div#prompt-textarea',
      'textarea[data-id="root"]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Pergunte" i]',
      'div[contenteditable="true"][data-placeholder]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"][aria-label*="Write" i]',
      'div[contenteditable="true"][aria-label*="Escreva" i]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea',
    ];

    for (const sel of candidates) {
      const els = queryAll(sel);
      // Prefere o mais próximo do rodapé (composer)
      const sorted = els.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      for (const el of sorted) {
        // Ignora editores dentro do nosso painel
        if (el.closest('#cca-root')) continue;
        // Ignora contenteditables muito no topo (títulos etc.)
        const top = el.getBoundingClientRect().top;
        if (top < window.innerHeight * 0.35 && els.length > 1) continue;
        return el;
      }
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Enviar" i]',
      'button[type="submit"]',
    ];
    for (const sel of selectors) {
      const el = queryAll(sel).find((b) => !b.disabled && !b.closest('#cca-root'));
      if (el) return el;
    }
    return null;
  }

  function setComposerText(el, text) {
    if (!el) return false;

    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      );
      proto?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el.isContentEditable) {
      // ChatGPT / Claude usam contenteditable; limpar e inserir.
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);

      // Fallback se execCommand falhar
      if (!(el.textContent || '').includes(text.slice(0, Math.min(12, text.length)))) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return true;
    }

    return false;
  }

  function pressEnter(el) {
    if (!el) return;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
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

    const ok = setComposerText(composer, text);
    if (!ok) {
      setStatus('Não consegui preencher o input.');
      return false;
    }

    await sleep(BEFORE_SEND_MS);

    const sendBtn = findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      pressEnter(composer);
    }

    state.lastSendAt = Date.now();
    return true;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─── Máquina de estados ──────────────────────────────────────────

  async function onGenerationEnded() {
    if (!state.armed || state.remaining <= 0 || state.pendingSend) return;

    // Evita reenvio imediato após o nosso próprio send
    if (Date.now() - state.lastSendAt < 1500) return;

    state.pendingSend = true;
    setStatus(`IA parou. Enviando em ${AFTER_IDLE_MS / 1000}s… (restam ${state.remaining})`);

    await sleep(AFTER_IDLE_MS);

    if (!state.armed || state.remaining <= 0) {
      state.pendingSend = false;
      return;
    }

    // Se voltou a gerar (usuário ou outro), aborta este ciclo
    if (isGenerating()) {
      state.pendingSend = false;
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
        setStatus('Concluído. Todas as inserções foram enviadas.');
        updateFab();
      } else {
        setStatus(`Enviado. Aguardando próxima resposta… (restam <strong>${state.remaining}</strong>)`);
      }
    }
    state.pendingSend = false;
    updateFab();
  }

  function tick() {
    const gen = isGenerating();

    if (state.armed) {
      if (state.wasGenerating && !gen) {
        onGenerationEnded();
      } else if (!state.pendingSend) {
        if (gen) {
          setStatus(`IA gerando… depois envia (restam <strong>${state.remaining}</strong>)`);
        } else if (state.remaining > 0 && Date.now() - state.lastSendAt > 2000) {
          setStatus(`Aguardando a IA terminar uma resposta… (restam <strong>${state.remaining}</strong>)`);
        }
      }
    }

    state.wasGenerating = gen;
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
    chrome.storage.local.set({
      [STORAGE_KEY]: { text: state.text, times: state.times },
    });
  }

  function start() {
    persistUiFields();
    const timesEl = rootEl.querySelector('#cca-times');
    const n = Math.max(1, parseInt(timesEl.value, 10) || 1);
    state.times = n;
    state.remaining = n;
    state.armed = true;
    state.pendingSend = false;
    state.wasGenerating = isGenerating();
    updateFab();

    if (state.wasGenerating) {
      setStatus(`Ativo. Aguardando a IA terminar… (restam <strong>${n}</strong>)`);
    } else {
      // Idle: envia o primeiro agora; os demais após cada fim de geração.
      setStatus(`Ativo. Enviando o 1º agora… (restam <strong>${n}</strong>)`);
      (async () => {
        state.pendingSend = true;
        const sent = await sendMessage(state.text);
        if (sent) {
          state.remaining -= 1;
          if (state.remaining <= 0) {
            state.armed = false;
            setStatus('Concluído. Todas as inserções foram enviadas.');
          } else {
            setStatus(`1º enviado. Aguardando a IA terminar… (restam <strong>${state.remaining}</strong>)`);
          }
        }
        state.pendingSend = false;
        updateFab();
      })();
    }
  }

  function stop() {
    state.armed = false;
    state.remaining = 0;
    state.pendingSend = false;
    setStatus('Parado.');
    updateFab();
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    const panel = rootEl.querySelector('#cca-panel');
    if (panel) panel.dataset.open = state.panelOpen ? '1' : '0';
  }

  function buildUi() {
    if (document.getElementById('cca-root')) return;

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
          terminar uma resposta. Clique no ícone flutuante para abrir/fechar.
        </p>
      </div>
      <div id="cca-fab-wrap">
        <button type="button" id="cca-fab" title="Chat Continue Auto">↻</button>
      </div>
    `;
    document.documentElement.appendChild(rootEl);

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
    textEl.addEventListener('change', persistUiFields);
    timesEl.addEventListener('change', persistUiFields);
  }

  function loadSettings(cb) {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const s = data?.[STORAGE_KEY] || {};
      state.text = typeof s.text === 'string' && s.text ? s.text : DEFAULTS.text;
      state.times = Number.isFinite(s.times) && s.times >= 1 ? s.times : DEFAULTS.times;
      cb();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cca-toggle-panel') {
      if (!rootEl) buildUi();
      togglePanel();
    }
  });

  loadSettings(() => {
    buildUi();
    setInterval(tick, POLL_MS);
  });
})();
