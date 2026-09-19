// notebooklm-bridge.js — Executado no MAIN world de notebooklm.google.com
// Permite interceptar eventos nativos, manipular protótipos e interagir diretamente
// com a interface do NotebookLM sem barreiras de sandbox do content script.

(function () {
  if (window.__CCA_NLM_BRIDGE_LOADED__) return;
  window.__CCA_NLM_BRIDGE_LOADED__ = true;
  console.log('[CCA-Bridge] Main World Bridge ativo no NotebookLM.');

  try {
    if (!document.getElementById('cca-bridge-styles')) {
      const style = document.createElement('style');
      style.id = 'cca-bridge-styles';
      style.textContent = `
        .cca-nlm-highlighted-btn {
          animation: cca-nlm-pulse 1.2s infinite alternate !important;
          outline: 3px solid #22c55e !important;
          outline-offset: 3px !important;
          box-shadow: 0 0 20px rgba(34, 197, 94, 0.85) !important;
          cursor: pointer !important;
        }
        @keyframes cca-nlm-pulse {
          from {
            outline: 3px solid #22c55e !important;
            box-shadow: 0 0 10px rgba(34, 197, 94, 0.6) !important;
          }
          to {
            outline: 4px solid #4ade80 !important;
            box-shadow: 0 0 25px rgba(74, 222, 128, 0.95) !important;
          }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  } catch (_) {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Interceptadores Globais Armados no MAIN World ──────────────
  let __armedFiles = null;
  let __armedTimer = null;
  let __highlightWatcherTimer = null;
  let __highlightObserver = null;

  function stopHighlightWatcher() {
    if (__highlightWatcherTimer) {
      clearInterval(__highlightWatcherTimer);
      __highlightWatcherTimer = null;
    }
    if (__highlightObserver) {
      __highlightObserver.disconnect();
      __highlightObserver = null;
    }
  }

  function clearHighlights() {
    try {
      document.querySelectorAll('.cca-nlm-modal-upload-highlighted, .cca-nlm-highlighted-btn').forEach((el) => {
        if (el.closest('#cca-root') || el.id?.startsWith('cca-')) return;
        el.classList.remove('cca-nlm-modal-upload-highlighted', 'cca-nlm-highlighted-btn');
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
        el.style.removeProperty('box-shadow');
        el.style.removeProperty('animation');
      });
    } catch (_) {}
  }

  function armInterceptor(webFiles) {
    __armedFiles = webFiles;
    clearTimeout(__armedTimer);
    __armedTimer = setTimeout(() => {
      __armedFiles = null;
      stopHighlightWatcher();
      clearHighlights();
      console.log('[CCA-Bridge] Interceptador de arquivos desarmado por timeout.');
    }, 60000);

    if (!window.__ccaInputClickHooked) {
      window.__ccaInputClickHooked = true;
      const origInputClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file' && __armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: input[type="file"].click() interceptado!', this);
          const filesToInject = __armedFiles;
          __armedFiles = null;
          stopHighlightWatcher();
          clearHighlights();
          setFilesOnInput(this, filesToInject);
          setTimeout(() => {
            setFilesOnInput(this, filesToInject);
            window.postMessage(
              {
                type: 'CCA_NLM_UPLOAD_CONFIRMED',
                count: filesToInject.length,
                fileNames: filesToInject.map((f) => f.name)
              },
              '*'
            );
          }, 30);
          return; // Suprime a abertura da janela do SO!
        }
        return origInputClick.apply(this, arguments);
      };
    }

    if (!window.__ccaInputShowPickerHooked && typeof HTMLInputElement.prototype.showPicker === 'function') {
      window.__ccaInputShowPickerHooked = true;
      const origShowPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function () {
        if (this.type === 'file' && __armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: input[type="file"].showPicker() interceptado!', this);
          const filesToInject = __armedFiles;
          __armedFiles = null;
          stopHighlightWatcher();
          clearHighlights();
          setFilesOnInput(this, filesToInject);
          setTimeout(() => {
            setFilesOnInput(this, filesToInject);
            window.postMessage(
              {
                type: 'CCA_NLM_UPLOAD_CONFIRMED',
                count: filesToInject.length,
                fileNames: filesToInject.map((f) => f.name)
              },
              '*'
            );
          }, 30);
          return; // Suprime o picker nativo do SO!
        }
        return origShowPicker.apply(this, arguments);
      };
    }

    if (!window.__ccaPickerHooked && typeof window.showOpenFilePicker === 'function') {
      window.__ccaPickerHooked = true;
      const origPicker = window.showOpenFilePicker;
      window.showOpenFilePicker = async function (opts) {
        if (__armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: window.showOpenFilePicker() interceptado!', opts);
          const filesToInject = __armedFiles;
          __armedFiles = null;
          stopHighlightWatcher();
          clearHighlights();
          window.postMessage(
            {
              type: 'CCA_NLM_UPLOAD_CONFIRMED',
              count: filesToInject.length,
              fileNames: filesToInject.map((f) => f.name)
            },
            '*'
          );
          return filesToInject.map((wf) => ({
            kind: 'file',
            name: wf.name,
            getFile: async () => wf,
            isSameEntry: async () => false,
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted'
          }));
        }
        return origPicker.apply(this, arguments);
      };
    }
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.data?.type !== 'CCA_NLM_BRIDGE_REQ') return;
    const { reqId, action, payload } = ev.data;

    if (action === 'ping') {
      window.postMessage({ type: 'CCA_NLM_BRIDGE_RES', reqId, ok: true, pong: true }, '*');
      return;
    }

    if (action === 'upload_files') {
      try {
        const res = await handleUploadFiles(payload);
        window.postMessage({ type: 'CCA_NLM_BRIDGE_RES', reqId, ok: res.ok, ...res }, '*');
      } catch (err) {
        console.error('[CCA-Bridge] Erro em handleUploadFiles:', err);
        window.postMessage(
          {
            type: 'CCA_NLM_BRIDGE_RES',
            reqId,
            ok: false,
            error: err?.message || String(err)
          },
          '*'
        );
      }
    }

    if (action === 'upload_text_sources') {
      try {
        const res = await handleUploadTextSources(payload);
        window.postMessage({ type: 'CCA_NLM_BRIDGE_RES', reqId, ok: res.ok, ...res }, '*');
      } catch (err) {
        console.error('[CCA-Bridge] Erro em handleUploadTextSources:', err);
        window.postMessage(
          {
            type: 'CCA_NLM_BRIDGE_RES',
            reqId,
            ok: false,
            error: err?.message || String(err)
          },
          '*'
        );
      }
    }

    if (action === 'highlight_modal_button') {
      const highlighted = ensureModalButtonHighlighted();
      window.postMessage({ type: 'CCA_NLM_BRIDGE_RES', reqId, ok: true, highlighted }, '*');
      return;
    }
  });

  // ─── Disparo de Cliques Fidedigno aos Componentes do Google ─────

  function triggerClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const baseOpts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: window.screenX + clientX,
      screenY: window.screenY + clientY
    };

    // 1. Pointerdown / Mousedown com button: 0 e buttons: 1
    el.dispatchEvent(new PointerEvent('pointerdown', { ...baseOpts, button: 0, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...baseOpts, button: 0, buttons: 1 }));

    // 2. Pointerup / Mouseup com button: 0 e buttons: 0
    el.dispatchEvent(new PointerEvent('pointerup', { ...baseOpts, button: 0, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...baseOpts, button: 0, buttons: 0 }));

    // 3. Click
    el.dispatchEvent(new MouseEvent('click', { ...baseOpts, button: 0, buttons: 0 }));
    if (typeof el.click === 'function') {
      try {
        el.click();
      } catch (_) {}
    }

    // Se houver filho interativo interno, também repassa o clique
    const inner = el.querySelector('button, [role="button"], span, label');
    if (inner && inner !== el) {
      try {
        inner.dispatchEvent(new MouseEvent('click', { ...baseOpts, button: 0, buttons: 0 }));
        if (typeof inner.click === 'function') inner.click();
      } catch (_) {}
    }
  }

  // ─── Localizadores de Elementos no DOM do NotebookLM ─────────────

  function getOpenDialog() {
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"], mat-dialog-container, .cdk-overlay-pane, div[aria-modal="true"]')
    );
    return (
      dialogs.find((d) => {
        if (d.closest('#cca-root') || d.id?.startsWith('cca-')) return false;
        if (d.offsetParent === null && d.offsetWidth === 0 && d.offsetHeight === 0) return false;
        const txt = (d.textContent || '').replace(/\s+/g, ' ').toLowerCase();
        return (
          txt.includes('solte seus arquivos') ||
          txt.includes('drop your files') ||
          txt.includes('adicionar fontes') ||
          txt.includes('add sources') ||
          txt.includes('pesquise novas fontes') ||
          txt.includes('enviar arquivos') ||
          txt.includes('fazer upload') ||
          txt.includes('upload files')
        );
      }) || null
    );
  }

  function findAddSourceButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div[tabindex="0"]'));
    return (
      buttons.find((b) => {
        if (b.closest('#cca-root') || b.id?.startsWith('cca-')) return false;
        if (b.offsetParent === null && b.offsetWidth === 0 && b.offsetHeight === 0) return false;
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const a = (b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const title = (b.getAttribute('title') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const combined = `${t} ${a} ${title}`.trim();
        return (
          combined.includes('adicionar fonte') ||
          combined.includes('adicionar fontes') ||
          combined.includes('add source') ||
          combined.includes('add sources') ||
          combined.includes('nova fonte') ||
          combined.includes('new source')
        );
      }) ||
      document.querySelector('button[aria-label*="fonte" i], button[aria-label*="source" i]')
    );
  }

  function findUploadButton(dialog) {
    function searchContainer(root) {
      if (!root) return null;
      const excludeTerms = ['drive', 'google drive', 'sites', 'website', 'livros', 'copiado', 'copied', 'pesquisa no google', 'youtube'];
      const isExcluded = (str) => excludeTerms.some((term) => str.includes(term));

      // 1. Busca em botões e elementos interativos
      const candidates = Array.from(
        root.querySelectorAll('button, [role="button"], a.mat-button, label, div[tabindex="0"], mat-card, .mat-mdc-button, .mdc-button')
      );
      for (const el of candidates) {
        if (el.closest('#cca-root') || el.id?.startsWith('cca-')) continue;
        if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const a = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const title = (el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const combined = `${t} ${a} ${title}`.trim();

        if (isExcluded(combined)) continue;

        if (
          combined.includes('enviar arquivo') ||
          combined.includes('enviar arquivos') ||
          combined.includes('upload file') ||
          combined.includes('upload files') ||
          combined.includes('fazer upload') ||
          combined.includes('upload de arquivo') ||
          combined.includes('upload de arquivos') ||
          combined.includes('subir archivo') ||
          combined.includes('subir arquivos') ||
          (combined.includes('upload') && !combined.includes('drive'))
        ) {
          return el;
        }
      }

      // 2. Busca por texto interno em spans, divs, rótulos ou ícones
      const labels = Array.from(
        root.querySelectorAll('.mdc-button__label, span, div, p, label, mat-icon, [class*="label"], [class*="title"]')
      );
      for (const s of labels) {
        if (s.closest('#cca-root') || s.id?.startsWith('cca-')) continue;
        if (s.offsetParent === null && s.offsetWidth === 0 && s.offsetHeight === 0) continue;
        const t = (s.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (isExcluded(t)) continue;

        if (
          t === 'enviar arquivos' ||
          t === 'enviar arquivo' ||
          t === 'fazer upload' ||
          t === 'fazer upload de arquivos' ||
          t === 'upload de arquivos' ||
          t === 'upload de arquivo' ||
          t === 'upload files' ||
          t === 'upload file' ||
          t === 'upload' ||
          t === 'subir arquivos' ||
          t === 'subir archivo' ||
          t.includes('fazer upload') ||
          t.includes('enviar arquivo') ||
          t.includes('upload file') ||
          t.includes('upload de arquivo') ||
          t.includes('subir archivo')
        ) {
          const clickable =
            s.closest('button, [role="button"], label, div[tabindex="0"], mat-card, .mat-mdc-button, .mdc-button') ||
            s.parentElement ||
            s;
          if (clickable && !clickable.closest('#cca-root')) {
            return clickable;
          }
        }
      }
      return null;
    }

    if (dialog) {
      const found = searchContainer(dialog);
      if (found) return found;
    }
    return searchContainer(document);
  }

  function findCopiedTextButton(dialog) {
    const root = dialog || document;
    const candidates = Array.from(
      root.querySelectorAll('button, [role="button"], a.mat-button, div[role="button"], label, div, span, a')
    );
    return candidates.find((b) => {
      if (b.offsetParent === null && b.offsetWidth === 0) return false;
      if (b.children.length > 4) return false;
      const t = (b.textContent || '').trim().toLowerCase();
      const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      return (
        t.includes('texto copiado') ||
        t.includes('copied text') ||
        t.includes('pegar texto') ||
        a.includes('texto copiado') ||
        a.includes('copied text')
      );
    });
  }

  function findDropZone(dialog) {
    const root = dialog || document;
    const candidates = Array.from(root.querySelectorAll('*')).filter((el) => {
      const t = (el.textContent || '').toLowerCase();
      return t.includes('solte seus arquivos') || t.includes('drop your files') || t.includes('suelta tus arquivos');
    });

    for (const c of candidates) {
      let cur = c;
      while (cur && cur !== root && cur !== document.body) {
        const style = window.getComputedStyle(cur);
        const borderTop = (style.borderTopStyle || '').toLowerCase();
        const border = (style.borderStyle || '').toLowerCase();
        const cls = (cur.className || '').toString().toLowerCase();
        if (
          border.includes('dashed') ||
          borderTop.includes('dashed') ||
          border.includes('dotted') ||
          cls.includes('dashed') ||
          cls.includes('drop') ||
          cls.includes('drag')
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
    }

    return candidates[0]?.parentElement || null;
  }

  function findAnyFileInput(root = document) {
    let inp = root.querySelector('input[type="file"]');
    if (inp) return inp;
    const els = root.querySelectorAll('*');
    for (const el of els) {
      if (el.shadowRoot) {
        inp = findAnyFileInput(el.shadowRoot);
        if (inp) return inp;
      }
    }
    return null;
  }

  function setFilesOnInput(inputEl, webFiles) {
    const dt = new DataTransfer();
    for (const wf of webFiles) dt.items.add(wf);

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (nativeSetter) {
      try {
        nativeSetter.call(inputEl, dt.files);
      } catch (_) {
        inputEl.files = dt.files;
      }
    } else {
      inputEl.files = dt.files;
    }

    inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    if (typeof inputEl.onchange === 'function') {
      try {
        inputEl.onchange(new Event('change', { bubbles: true, composed: true }));
      } catch (_) {}
    }
  }

  function simulateFullDragDrop(dropTarget, webFiles) {
    const dt = new DataTransfer();
    for (const wf of webFiles) dt.items.add(wf);

    const rect = dropTarget.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const dragOpts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: dt,
      clientX,
      clientY
    };

    dropTarget.dispatchEvent(new DragEvent('dragenter', dragOpts));
    dropTarget.dispatchEvent(new DragEvent('dragover', dragOpts));
    dropTarget.dispatchEvent(new DragEvent('drop', dragOpts));

    const innerTextEl = dropTarget.querySelector('div, p, span');
    if (innerTextEl && innerTextEl !== dropTarget) {
      innerTextEl.dispatchEvent(new DragEvent('dragenter', dragOpts));
      innerTextEl.dispatchEvent(new DragEvent('dragover', dragOpts));
      innerTextEl.dispatchEvent(new DragEvent('drop', dragOpts));
    }
  }

  function isUploadActive(dialog) {
    if (!dialog || !dialog.isConnected) return true;
    const txt = (dialog.textContent || '').toLowerCase();
    if (
      txt.includes('fazendo upload') ||
      txt.includes('uploading') ||
      txt.includes('enviando') ||
      txt.includes('processando') ||
      txt.includes('processing') ||
      txt.includes('adicionando')
    ) {
      return true;
    }
    const indicators = dialog.querySelectorAll(
      'mat-progress-bar, mat-progress-spinner, [role="progressbar"], [class*="progress"], [class*="spinner"], [class*="loading"]'
    );
    return indicators.length > 0;
  }

  function base64ToArrayBuffer(base64) {
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // ─── Destaque Contínuo e Injeção do Botão "Enviar arquivos" ─────

  function ensureModalButtonHighlighted() {
    if (!__armedFiles || __armedFiles.length === 0) return false;
    const dialog = getOpenDialog();
    if (!dialog) return false;
    let uploadBtn = findUploadButton(dialog);
    if (!uploadBtn) return false;

    if (uploadBtn.tagName.toLowerCase() !== 'button' && uploadBtn.tagName.toLowerCase() !== 'label') {
      uploadBtn = uploadBtn.closest('button, [role="button"], label, .mdc-button') || uploadBtn;
    }

    if (!uploadBtn.classList.contains('cca-nlm-modal-upload-highlighted')) {
      console.log('[CCA-Bridge] Destacando botão "Enviar arquivos" no modal do NotebookLM:', uploadBtn);
      uploadBtn.classList.add('cca-nlm-modal-upload-highlighted', 'cca-nlm-highlighted-btn');
      uploadBtn.style.setProperty('outline', '3px solid #22c55e', 'important');
      uploadBtn.style.setProperty('outline-offset', '3px', 'important');
      uploadBtn.style.setProperty('box-shadow', '0 0 24px rgba(34, 197, 94, 0.9)', 'important');
      uploadBtn.style.setProperty('animation', 'cca-nlm-pulse 1.2s infinite alternate', 'important');
      uploadBtn.style.setProperty('cursor', 'pointer', 'important');
      uploadBtn.style.setProperty('border-radius', '9999px', 'important');
      try {
        uploadBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
    }

    if (!uploadBtn.__ccaClickAttached) {
      uploadBtn.__ccaClickAttached = true;
      uploadBtn.addEventListener(
        'click',
        () => {
          console.log('[CCA-Bridge] Clique no botão "Enviar arquivos" destacado!');
          setTimeout(() => {
            if (__armedFiles && __armedFiles.length > 0) {
              const fileInput = findAnyFileInput(dialog) || findAnyFileInput(document);
              if (fileInput) {
                console.log('[CCA-Bridge] Injetando arquivos diretamente no fileInput:', fileInput);
                const filesToInject = __armedFiles;
                __armedFiles = null;
                stopHighlightWatcher();
                clearHighlights();
                setFilesOnInput(fileInput, filesToInject);
                window.postMessage(
                  {
                    type: 'CCA_NLM_UPLOAD_CONFIRMED',
                    count: filesToInject.length,
                    fileNames: filesToInject.map((f) => f.name)
                  },
                  '*'
                );
              }
            }
          }, 35);
        },
        { once: true }
      );
    }

    // Hook de fechamento do modal pelo usuário (botão X, Fechar, Cancelar)
    if (dialog && !dialog.__ccaCloseHooked) {
      dialog.__ccaCloseHooked = true;
      const closeButtons = dialog.querySelectorAll(
        'button[aria-label*="close" i], button[aria-label*="fechar" i], button[aria-label*="cancel" i], button.close, [mat-dialog-close]'
      );
      closeButtons.forEach((cb) => {
        cb.addEventListener(
          'click',
          () => {
            console.log('[CCA-Bridge] Modal fechado pelo usuário via botão Fechar/Cancelar.');
            __armedFiles = null;
            stopHighlightWatcher();
            clearHighlights();
            window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
          },
          { once: true }
        );
      });
    }

    // Hook no backdrop do CDK overlay para detectar fechamento ao clicar fora do modal
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop && !backdrop.__ccaBackdropHooked) {
      backdrop.__ccaBackdropHooked = true;
      backdrop.addEventListener(
        'click',
        () => {
          console.log('[CCA-Bridge] Modal fechado pelo usuário via clique no backdrop.');
          __armedFiles = null;
          stopHighlightWatcher();
          clearHighlights();
          window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
        },
        { once: true }
      );
    }

    return true;
  }

  if (!window.__ccaEscapeHooked) {
    window.__ccaEscapeHooked = true;
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && __armedFiles) {
        console.log('[CCA-Bridge] Modal fechado pelo usuário via tecla Escape.');
        __armedFiles = null;
        stopHighlightWatcher();
        clearHighlights();
        window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
      }
    });
  }

  function startHighlightWatcher() {
    stopHighlightWatcher();
    ensureModalButtonHighlighted();

    // 1. Intervalo de monitoramento rápido para capturar renderização do Angular sem forçar abertura de modal
    let elapsed = 0;
    __highlightWatcherTimer = setInterval(() => {
      elapsed += 250;
      if (!__armedFiles || elapsed > 30000) {
        stopHighlightWatcher();
        return;
      }
      const dialog = getOpenDialog();
      if (!dialog) {
        console.log('[CCA-Bridge] Modal fechado detectado pelo watcher.');
        __armedFiles = null;
        stopHighlightWatcher();
        clearHighlights();
        window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
        return;
      }
      ensureModalButtonHighlighted();
    }, 250);

    // 2. MutationObserver para reagir instantaneamente quando o modal for inserido ou removido do DOM
    try {
      __highlightObserver = new MutationObserver(() => {
        if (__armedFiles && __armedFiles.length > 0) {
          const dialog = getOpenDialog();
          if (dialog) {
            ensureModalButtonHighlighted();
          } else {
            console.log('[CCA-Bridge] Modal fechado detectado pelo MutationObserver.');
            __armedFiles = null;
            stopHighlightWatcher();
            clearHighlights();
            window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
          }
        }
      });
      __highlightObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (_) {}
  }

  async function handleUploadFiles(payload) {
    const rawFiles = payload?.files || [];
    if (!rawFiles.length) {
      return { ok: false, error: 'Nenhum arquivo recebido para envio.' };
    }

    // Converte dados para instâncias File nativas do MAIN world
    const webFiles = rawFiles.map((f) => {
      let content;
      if (typeof f.text === 'string' && f.text.length > 0) {
        content = f.text;
      } else if (f.base64) {
        content = base64ToArrayBuffer(f.base64);
      } else if (f.buffer instanceof ArrayBuffer && f.buffer.byteLength > 0) {
        content = f.buffer;
      } else if (Array.isArray(f.buffer) && f.buffer.length > 0) {
        content = new Uint8Array(f.buffer).buffer;
      } else if (typeof f.text === 'string') {
        content = f.text;
      } else {
        content = '';
      }

      const mime = f.type || (f.name.endsWith('.md') ? 'text/markdown' : 'text/plain');
      return new File([content], f.name, {
        type: mime,
        lastModified: f.lastModified || Date.now()
      });
    });

    console.log(
      '[CCA-Bridge] Armado interceptador com',
      webFiles.length,
      'arquivo(s):',
      webFiles.map((f) => f.name)
    );

    // 1. Arma o interceptador global no MAIN world
    armInterceptor(webFiles);

    // 2. Inicia o watcher contínuo que busca o botão e o destaca no modal do NotebookLM
    startHighlightWatcher();

    return {
      ok: true,
      waitingManualClick: true,
      count: webFiles.length,
      fileNames: webFiles.map((f) => f.name)
    };
  }

  // ─── Execução do Envio como TEXTO COPIADO ────────────────────────

  async function handleUploadTextSources(payload) {
    const rawFiles = payload.files || [];
    if (!rawFiles.length) {
      return { ok: false, error: 'Nenhum arquivo recebido para envio.' };
    }

    console.log('[CCA-Bridge] Iniciando inserção via "Texto copiado" para', rawFiles.length, 'fontes...');
    let addedCount = 0;

    for (let i = 0; i < rawFiles.length; i++) {
      const rf = rawFiles[i];
      let curDialog = getOpenDialog();
      if (!curDialog) {
        const addBtn = findAddSourceButton();
        if (addBtn) {
          triggerClick(addBtn);
          for (let w = 0; w < 10; w++) {
            await sleep(100);
            curDialog = getOpenDialog();
            if (curDialog) break;
          }
        }
      }
      if (!curDialog) break;

      const copiedBtn = findCopiedTextButton(curDialog);
      if (!copiedBtn) {
        console.warn('[CCA-Bridge] Botão "Texto copiado" não encontrado.');
        break;
      }

      triggerClick(copiedBtn);
      await sleep(500);

      curDialog = getOpenDialog() || curDialog;

      const inputs = Array.from(curDialog.querySelectorAll('input[type="text"], input:not([type])'));
      const titleInput = inputs.find((inp) => inp.offsetParent !== null) || inputs[0];
      const contentArea = curDialog.querySelector('textarea, [contenteditable="true"]');

      if (titleInput) {
        titleInput.value = rf.name;
        titleInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        titleInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }

      if (contentArea) {
        const fileContent = rf.text || (rf.buffer ? new TextDecoder().decode(new Uint8Array(rf.buffer)) : '');
        if (contentArea.tagName.toLowerCase() === 'textarea') {
          contentArea.value = fileContent;
        } else {
          contentArea.innerText = fileContent;
        }
        contentArea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        contentArea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }

      await sleep(400);

      const insertBtn = Array.from(curDialog.querySelectorAll('button, [role="button"]')).find((b) => {
        if (b.offsetParent === null) return false;
        const t = (b.textContent || '').trim().toLowerCase();
        return t === 'inserir' || t === 'insert' || t.includes('inserir') || t.includes('insert');
      });

      if (insertBtn) {
        triggerClick(insertBtn);
        addedCount++;
        await sleep(1200);
      }
    }

    return {
      ok: addedCount > 0,
      method: 'copied_text',
      count: addedCount,
      fileNames: rawFiles.slice(0, addedCount).map((f) => f.name)
    };
  }
})();
