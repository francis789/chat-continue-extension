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
        .cca-nlm-batch-bar {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 8px !important;
          margin-top: 12px !important;
          margin-bottom: 6px !important;
          padding: 8px 16px !important;
          border-radius: 12px !important;
          background: rgba(34, 197, 94, 0.08) !important;
          border: 1.5px solid rgba(34, 197, 94, 0.45) !important;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08) !important;
          width: fit-content !important;
          max-width: 95% !important;
          margin-left: auto !important;
          margin-right: auto !important;
          align-self: center !important;
          font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif !important;
          box-sizing: border-box !important;
          animation: cca-batch-bar-fadein 0.25s ease-out !important;
          z-index: 10 !important;
          overflow: visible !important;
        }
        @keyframes cca-batch-bar-fadein {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .cca-nlm-batch-header {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 12px !important;
          flex-wrap: wrap !important;
          overflow: visible !important;
        }
        .cca-nlm-batch-badge {
          display: inline-flex !important;
          align-items: center !important;
          gap: 6px !important;
          font-size: 13px !important;
          font-weight: 500 !important;
          color: inherit !important;
        }
        .cca-nlm-batch-code {
          display: inline-block !important;
          background: rgba(34, 197, 94, 0.18) !important;
          color: #15803d !important;
          padding: 2px 8px !important;
          border-radius: 6px !important;
          font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace !important;
          font-weight: 700 !important;
          font-size: 13px !important;
          letter-spacing: 0.5px !important;
        }
        .cca-nlm-batch-count {
          font-size: 12px !important;
          opacity: 0.85 !important;
        }
        .cca-nlm-cancel-btn {
          display: inline-flex !important;
          align-items: center !important;
          gap: 6px !important;
          padding: 6px 14px !important;
          border-radius: 9999px !important;
          font-size: 12px !important;
          font-weight: 600 !important;
          cursor: pointer !important;
          border: 1px solid #f87171 !important;
          background: rgba(239, 68, 68, 0.12) !important;
          color: #dc2626 !important;
          transition: all 0.2s ease !important;
          position: relative !important;
          user-select: none !important;
          outline: none !important;
        }
        .cca-nlm-cancel-btn:hover {
          background: #dc2626 !important;
          color: #ffffff !important;
          border-color: #dc2626 !important;
          box-shadow: 0 0 12px rgba(220, 38, 38, 0.45) !important;
        }
        .cca-nlm-cancel-btn:active {
          transform: scale(0.97) !important;
        }
        .cca-nlm-cancel-btn .cca-nlm-tooltip-bubble {
          visibility: hidden !important;
          opacity: 0 !important;
          position: absolute !important;
          bottom: calc(100% + 8px) !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          background: #1e293b !important;
          color: #ffffff !important;
          font-size: 11.5px !important;
          font-weight: normal !important;
          padding: 7px 12px !important;
          border-radius: 6px !important;
          white-space: normal !important;
          width: 260px !important;
          text-align: center !important;
          line-height: 1.4 !important;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35) !important;
          pointer-events: none !important;
          transition: opacity 0.2s ease, visibility 0.2s ease !important;
          z-index: 99999 !important;
        }
        .cca-nlm-cancel-btn:hover .cca-nlm-tooltip-bubble {
          visibility: visible !important;
          opacity: 1 !important;
        }
        .cca-nlm-cancel-btn .cca-nlm-tooltip-bubble::after {
          content: '' !important;
          position: absolute !important;
          top: 100% !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          border-width: 5px !important;
          border-style: solid !important;
          border-color: #1e293b transparent transparent transparent !important;
        }
        .cca-nlm-reactivate-btn {
          border-color: #3b82f6 !important;
          background: rgba(59, 130, 246, 0.12) !important;
          color: #2563eb !important;
        }
        .cca-nlm-reactivate-btn:hover {
          background: #2563eb !important;
          color: #ffffff !important;
          border-color: #2563eb !important;
          box-shadow: 0 0 12px rgba(37, 99, 235, 0.45) !important;
        }
        .cca-nlm-manual-hint {
          font-size: 12px !important;
          line-height: 1.45 !important;
          text-align: center !important;
          color: #b45309 !important;
          background: rgba(245, 158, 11, 0.12) !important;
          border: 1px solid rgba(245, 158, 11, 0.35) !important;
          border-radius: 8px !important;
          padding: 6px 12px !important;
          margin-top: 4px !important;
        }
        .cca-nlm-badge-pill {
          display: inline-block !important;
          padding: 2px 8px !important;
          border-radius: 9999px !important;
          font-size: 11px !important;
          font-weight: 600 !important;
        }
        .cca-nlm-pill-warn {
          background: rgba(245, 158, 11, 0.2) !important;
          color: #d97706 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  } catch (_) {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function escapeHtmlBridge(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Interceptadores Globais Armados no MAIN World ──────────────
  let __armedFiles = null;
  let __armedTimer = null;
  let __highlightWatcherTimer = null;
  let __highlightObserver = null;
  let __autoUploadCancelledMomentarily = false;
  let __currentBatchInfo = {
    batchCode: '',
    folderName: '',
    path: '',
    count: 0,
    isCancelled: false
  };

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
      const dialog = getOpenDialog();
      document.querySelectorAll('.cca-nlm-modal-upload-highlighted, .cca-nlm-highlighted-btn').forEach((el) => {
        if (el.closest('#cca-root') || el.id?.startsWith('cca-')) return;
        // SE o diálogo ainda estiver aberto na tela, NÃO remove o destaque do botão Enviar arquivos!
        if (dialog && (dialog.contains(el) || el.closest('.cdk-overlay-pane, mat-dialog-container, [role="dialog"]'))) {
          return;
        }
        el.classList.remove('cca-nlm-modal-upload-highlighted', 'cca-nlm-highlighted-btn');
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
        el.style.removeProperty('box-shadow');
        el.style.removeProperty('animation');
      });
    } catch (_) {}
  }

  let __justInjectedTimestamp = 0;
  let __pendingAutoInjectOnClick = false;

  function updateArmedDataset(isArmed) {
    try {
      if (document.documentElement?.dataset) {
        document.documentElement.dataset.ccaNlmArmed = isArmed ? '1' : '0';
      }
    } catch (_) {}
  }

  function installNativeHooks() {
    if (!window.__ccaInputClickHooked) {
      window.__ccaInputClickHooked = true;
      const origInputClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file' && !__autoUploadCancelledMomentarily && __armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: input[type="file"].click() interceptado!', this);
          const filesToInject = __armedFiles;
          __armedFiles = null;
          updateArmedDataset(false);
          __justInjectedTimestamp = Date.now();
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
        if (this.type === 'file' && !__autoUploadCancelledMomentarily && Date.now() - __justInjectedTimestamp < 2000) {
          console.log('[CCA-Bridge] Suprimindo abertura de diálogo nativo após injeção automática recente.');
          return;
        }
        return origInputClick.apply(this, arguments);
      };
    }

    if (!window.__ccaInputShowPickerHooked && typeof HTMLInputElement.prototype.showPicker === 'function') {
      window.__ccaInputShowPickerHooked = true;
      const origShowPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function () {
        if (this.type === 'file' && !__autoUploadCancelledMomentarily && __armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: input[type="file"].showPicker() interceptado!', this);
          const filesToInject = __armedFiles;
          __armedFiles = null;
          updateArmedDataset(false);
          __justInjectedTimestamp = Date.now();
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
        if (this.type === 'file' && !__autoUploadCancelledMomentarily && Date.now() - __justInjectedTimestamp < 2000) {
          console.log('[CCA-Bridge] Suprimindo showPicker nativo após injeção automática recente.');
          return;
        }
        return origShowPicker.apply(this, arguments);
      };
    }

    if (!window.__ccaPickerHooked && typeof window.showOpenFilePicker === 'function') {
      window.__ccaPickerHooked = true;
      const origPicker = window.showOpenFilePicker;
      window.showOpenFilePicker = async function (opts) {
        if (!__autoUploadCancelledMomentarily && __armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: window.showOpenFilePicker() interceptado!', opts);
          const filesToInject = __armedFiles;
          __armedFiles = null;
          updateArmedDataset(false);
          __justInjectedTimestamp = Date.now();
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
        if (!__autoUploadCancelledMomentarily && Date.now() - __justInjectedTimestamp < 2000) {
          console.log('[CCA-Bridge] Suprimindo showOpenFilePicker nativo após injeção automática recente.');
          return [];
        }
        return origPicker.apply(this, arguments);
      };
    }
  }

  installNativeHooks();

  function armInterceptor(webFiles, batchInfo = {}) {
    __armedFiles = webFiles;
    __autoUploadCancelledMomentarily = false;
    updateArmedDataset(true);
    if (batchInfo) {
      if (batchInfo.batchCode) __currentBatchInfo.batchCode = batchInfo.batchCode;
      if (batchInfo.folderName) __currentBatchInfo.folderName = batchInfo.folderName;
      if (batchInfo.path) __currentBatchInfo.path = batchInfo.path;
      __currentBatchInfo.count = webFiles.length;
      __currentBatchInfo.isCancelled = false;
    }

    clearTimeout(__armedTimer);
    __armedTimer = setTimeout(() => {
      __armedFiles = null;
      updateArmedDataset(false);
      console.log('[CCA-Bridge] Interceptador de arquivos desarmado por timeout.');
      const dialog = getOpenDialog();
      if (dialog) {
        ensureModalButtonHighlighted();
        renderOrUpdateBatchInfo(dialog);
      }
    }, 60000);

    installNativeHooks();

    // Se o usuário clicou em "Enviar arquivos" antes dos arquivos terminarem de ler do disco, injeta imediatamente
    if (__pendingAutoInjectOnClick) {
      __pendingAutoInjectOnClick = false;
      const dialog = getOpenDialog();
      const fileInput = findAnyFileInput(dialog) || findAnyFileInput(document);
      if (fileInput && __armedFiles && __armedFiles.length > 0) {
        console.log('[CCA-Bridge] Injeção pendente acionada por clique prévio executada agora!');
        const filesToInject = __armedFiles;
        __armedFiles = null;
        updateArmedDataset(false);
        __justInjectedTimestamp = Date.now();
        setFilesOnInput(fileInput, filesToInject);
        setTimeout(() => {
          setFilesOnInput(fileInput, filesToInject);
        }, 30);
        window.postMessage(
          {
            type: 'CCA_NLM_UPLOAD_CONFIRMED',
            count: filesToInject.length,
            fileNames: filesToInject.map((f) => f.name)
          },
          '*'
        );
        if (dialog) renderOrUpdateBatchInfo(dialog);
      }
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

    if (action === 'update_batch_info') {
      if (payload) {
        if (payload.batchCode !== undefined) __currentBatchInfo.batchCode = payload.batchCode;
        if (payload.folderName !== undefined) __currentBatchInfo.folderName = payload.folderName;
        if (payload.path !== undefined) __currentBatchInfo.path = payload.path;
        if (payload.count !== undefined) __currentBatchInfo.count = payload.count;
        if (payload.isCancelled !== undefined) {
          __currentBatchInfo.isCancelled = Boolean(payload.isCancelled);
          __autoUploadCancelledMomentarily = Boolean(payload.isCancelled);
        }
      }
      const dialog = getOpenDialog();
      if (dialog) {
        ensureModalButtonHighlighted();
      }
      window.postMessage({ type: 'CCA_NLM_BRIDGE_RES', reqId, ok: true, batchInfo: __currentBatchInfo }, '*');
      return;
    }

    if (action === 'cancel_batch') {
      __armedFiles = null;
      __autoUploadCancelledMomentarily = true;
      __currentBatchInfo.isCancelled = true;
      clearTimeout(__armedTimer);
      const dialog = getOpenDialog();
      if (dialog) {
        ensureModalButtonHighlighted();
      }
      window.postMessage({ type: 'CCA_NLM_BRIDGE_RES', reqId, ok: true }, '*');
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
          txt.includes('upload files') ||
          txt.includes('selecionar arquivos') ||
          txt.includes('selecionar arquivo')
        );
      }) || null
    );
  }

  function findAddSourceButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div[tabindex="0"]'));
    const found = buttons.find((b) => {
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
        combined.includes('new source') ||
        combined.includes('adicionar arquivo') ||
        combined.includes('adicionar arquivos') ||
        combined.includes('inserir fonte') ||
        combined.includes('inserir fontes') ||
        (combined.includes('fonte') && combined.includes('+')) ||
        (combined.includes('source') && combined.includes('+'))
      );
    });
    if (found) return found;

    return (
      document.querySelector(
        'button[aria-label*="fonte" i], button[aria-label*="source" i], [data-test-id*="add-source" i], [aria-label*="adicionar fonte" i]'
      ) || null
    );
  }

  async function ensureOpenSourcesDialog(maxWaitMs = 3500) {
    let dialog = getOpenDialog();
    if (dialog) return dialog;

    const addBtn = findAddSourceButton();
    if (!addBtn) {
      console.warn('[CCA-Bridge] Botão para adicionar fontes não encontrado no DOM.');
      return null;
    }

    console.log('[CCA-Bridge] Modal não está aberto. Clicando em "Adicionar fontes" para abrir...');
    triggerClick(addBtn);

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await sleep(100);
      dialog = getOpenDialog();
      if (dialog) {
        console.log('[CCA-Bridge] Modal de fontes aberto com sucesso.');
        return dialog;
      }
    }
    return getOpenDialog();
  }

  function findUploadButton(dialog) {
    function searchContainer(root) {
      if (!root) return null;
      const excludeTerms = ['drive', 'google drive', 'sites', 'website', 'livros', 'copiado', 'copied', 'pesquisa no google', 'youtube'];
      const isExcluded = (str) => excludeTerms.some((term) => str.includes(term));

      // 1. Prioriza input[type="file"] e seu elemento clicável associado
      const fileInput = root.querySelector('input[type="file"]');
      if (fileInput) {
        const parentBtn = fileInput.closest('button, [role="button"], label, .mdc-button, mat-card');
        if (parentBtn && !parentBtn.closest('#cca-root') && parentBtn.offsetParent !== null) {
          return parentBtn;
        }
      }

      // 2. Busca em botões e elementos interativos
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
          combined.includes('selecionar arquivo') ||
          combined.includes('selecionar arquivos') ||
          combined.includes('selecionar do computador') ||
          combined.includes('escolher arquivo') ||
          combined.includes('escolher arquivos') ||
          combined.includes('select file') ||
          combined.includes('select files') ||
          combined.includes('choose file') ||
          combined.includes('choose files') ||
          (combined.includes('upload') && !combined.includes('drive'))
        ) {
          return el;
        }
      }

      // 3. Busca por texto interno em spans, divs, rótulos ou ícones
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
          t === 'selecionar arquivos' ||
          t === 'selecionar arquivo' ||
          t === 'escolher arquivos' ||
          t === 'escolher arquivo' ||
          t === 'select files' ||
          t === 'select file' ||
          t === 'choose files' ||
          t === 'choose file' ||
          t.includes('fazer upload') ||
          t.includes('enviar arquivo') ||
          t.includes('upload file') ||
          t.includes('upload de arquivo') ||
          t.includes('subir archivo') ||
          t.includes('selecionar arquivo') ||
          t.includes('selecionar arquivos') ||
          t.includes('escolher arquivo') ||
          t.includes('escolher arquivos') ||
          t.includes('select file') ||
          t.includes('choose file')
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
    const overlayContainer = document.querySelector('.cdk-overlay-container');
    if (overlayContainer) {
      const found = searchContainer(overlayContainer);
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

  function updateBarPosition(bar) {
    if (!bar) return;
    try {
      bar.style.setProperty('margin-left', 'auto', 'important');
      bar.style.setProperty('margin-right', 'auto', 'important');
      bar.style.setProperty('align-self', 'center', 'important');
    } catch (_) {}
  }

  function renderOrUpdateBatchInfo(dialog, uploadBtn) {
    if (!dialog) return;
    uploadBtn = uploadBtn || findUploadButton(dialog) || findUploadButton(document.querySelector('.cdk-overlay-container'));
    if (!uploadBtn) return;

    let buttonsRow = uploadBtn.closest('div[class*="row"], div[class*="button"], div[style*="display: flex"], div[style*="display:flex"]') || uploadBtn.parentElement;
    if (!buttonsRow) return;

    let bar = dialog.querySelector('#cca-nlm-batch-info-container');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cca-nlm-batch-info-container';
      bar.className = 'cca-nlm-batch-bar';
      buttonsRow.insertAdjacentElement('afterend', bar);
    }

    const datasetBatch = (document.documentElement.dataset?.ccaNlmBatchCode || '').trim();
    const rawBatchCode = (__currentBatchInfo.batchCode || __currentBatchInfo.folderName || datasetBatch || '').trim();
    const count = __currentBatchInfo.count || (__armedFiles ? __armedFiles.length : 0);
    const isCancelled = Boolean(
      __autoUploadCancelledMomentarily ||
      __currentBatchInfo.isCancelled ||
      document.documentElement.dataset?.ccaNlmCancelled === '1'
    );

    updateBarPosition(bar, uploadBtn, buttonsRow);

    const renderKey = `${rawBatchCode}__${count}__${isCancelled}`;
    if (bar.dataset.renderKey === renderKey && bar.children.length > 0) {
      return;
    }
    bar.dataset.renderKey = renderKey;

    // Limpa conteúdo anterior de forma segura sem violar Trusted Types
    while (bar.firstChild) {
      bar.removeChild(bar.firstChild);
    }

    const header = document.createElement('div');
    header.className = 'cca-nlm-batch-header';

    // 1. Badge informativa do lote
    const badge = document.createElement('div');
    badge.className = 'cca-nlm-batch-badge';

    const icon = document.createElement('span');
    icon.className = 'cca-nlm-batch-icon';
    icon.textContent = '📦';
    badge.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'cca-nlm-batch-label';
    label.textContent = isCancelled ? 'Lote:' : 'Lote a enviar:';
    badge.appendChild(label);

    const code = document.createElement('strong');
    code.className = 'cca-nlm-batch-code';
    code.textContent = rawBatchCode || 'Nenhum lote detectado';
    badge.appendChild(code);

    if (isCancelled) {
      const pill = document.createElement('span');
      pill.className = 'cca-nlm-badge-pill cca-nlm-pill-warn';
      pill.textContent = 'Envio automático suspenso';
      badge.appendChild(pill);
    } else if (rawBatchCode || (__armedFiles && __armedFiles.length > 0)) {
      const countEl = document.createElement('span');
      countEl.className = 'cca-nlm-batch-count';
      countEl.textContent = count > 0 ? `(${count} arquivo${count > 1 ? 's' : ''})` : '(arquivos prontos)';
      badge.appendChild(countEl);
    } else {
      const countEl = document.createElement('span');
      countEl.className = 'cca-nlm-batch-count';
      countEl.textContent = '(copie a pasta do lote)';
      badge.appendChild(countEl);
    }

    header.appendChild(badge);

    // 2. Botão de cancelamento / reativação com tooltip explicativa
    const tooltipText = isCancelled
      ? "Reativa o envio automático dos arquivos deste lote ao clicar em 'Enviar arquivos'."
      : "Cancela o envio automático deste lote no momento para que você possa clicar em 'Enviar arquivos' e selecionar os arquivos manualmente pelo computador.";

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = isCancelled ? 'cca-nlm-cancel-btn cca-nlm-reactivate-btn' : 'cca-nlm-cancel-btn';
    actionBtn.id = isCancelled ? 'cca-nlm-reactivate-auto-btn' : 'cca-nlm-cancel-auto-btn';
    actionBtn.title = tooltipText;

    const btnIcon = document.createElement('span');
    btnIcon.className = 'cca-icon';
    btnIcon.textContent = isCancelled ? '🔄 ' : '✕ ';
    actionBtn.appendChild(btnIcon);

    const btnText = document.createTextNode(isCancelled ? 'Reativar envio automático' : 'Cancelar envio automático');
    actionBtn.appendChild(btnText);

    // Tooltip visual flutuante
    const bubble = document.createElement('span');
    bubble.className = 'cca-nlm-tooltip-bubble';
    bubble.textContent = tooltipText;
    actionBtn.appendChild(bubble);

    if (isCancelled) {
      actionBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[CCA-Bridge] Reativação do envio automático acionada pelo usuário no modal.');
        __autoUploadCancelledMomentarily = false;
        __currentBatchInfo.isCancelled = false;
        if (document.documentElement.dataset) {
          document.documentElement.dataset.ccaNlmCancelled = '0';
        }
        bar.dataset.renderKey = '';
        window.postMessage({
          type: 'CCA_NLM_REACTIVATE_AUTO_UPLOAD',
          batchCode: __currentBatchInfo.batchCode,
          path: __currentBatchInfo.path
        }, '*');
        renderOrUpdateBatchInfo(dialog, uploadBtn);
        ensureModalButtonHighlighted();
      };
    } else {
      actionBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[CCA-Bridge] Cancelamento do envio automático acionado pelo usuário no modal.');
        __autoUploadCancelledMomentarily = true;
        __currentBatchInfo.isCancelled = true;
        __armedFiles = null;
        clearTimeout(__armedTimer);
        if (document.documentElement.dataset) {
          document.documentElement.dataset.ccaNlmCancelled = '1';
        }
        bar.dataset.renderKey = '';
        window.postMessage({
          type: 'CCA_NLM_AUTO_UPLOAD_CANCELLED',
          batchCode: __currentBatchInfo.batchCode,
          path: __currentBatchInfo.path
        }, '*');
        renderOrUpdateBatchInfo(dialog, uploadBtn);
        ensureModalButtonHighlighted();
      };
    }

    header.appendChild(actionBtn);
    bar.appendChild(header);

    // 3. Aviso explicativo em modo manual se cancelado
    if (isCancelled) {
      const hint = document.createElement('div');
      hint.className = 'cca-nlm-manual-hint';
      hint.textContent = '✋ Envio automático cancelado no momento. Clique no botão destacado "Enviar arquivos" acima para selecionar arquivos manualmente do seu computador.';
      bar.appendChild(hint);
    }
  }

  function ensureModalButtonHighlighted() {
    const dialog = getOpenDialog();
    if (!dialog) return false;
    let uploadBtn = findUploadButton(dialog) || findUploadButton(document.querySelector('.cdk-overlay-container'));
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

    renderOrUpdateBatchInfo(dialog, uploadBtn);

    if (!uploadBtn.__ccaClickAttached) {
      uploadBtn.__ccaClickAttached = true;
      uploadBtn.addEventListener(
        'click',
        (e) => {
          if (__autoUploadCancelledMomentarily) {
            console.log('[CCA-Bridge] Envio automático cancelado momentaneamente. Seleção manual ativada.');
            return;
          }

          if (__armedFiles && __armedFiles.length > 0) {
            console.log('[CCA-Bridge] Clique no botão "Enviar arquivos" com lote armado!');
            
            const fileInput = findAnyFileInput(dialog) || findAnyFileInput(document);
            if (fileInput) {
              console.log('[CCA-Bridge] Injetando arquivos diretamente no fileInput:', fileInput);

              const filesToInject = __armedFiles;
              // We do NOT clear __armedFiles yet, because showOpenFilePicker or input.click might still be called by NotebookLM
              // Let the native hooks clear it. But we will schedule a cleanup.
              setTimeout(() => {
                if (__armedFiles === filesToInject) {
                  __armedFiles = null;
                  updateArmedDataset(false);
                }
              }, 1000);
              
              __justInjectedTimestamp = Date.now();

              setFilesOnInput(fileInput, filesToInject);
              setTimeout(() => {
                setFilesOnInput(fileInput, filesToInject);
              }, 30);

              
              window.postMessage(
                {
                  type: 'CCA_NLM_UPLOAD_CONFIRMED',
                  count: filesToInject.length,
                  fileNames: filesToInject.map((f) => f.name)
                },
                '*'
              );
              renderOrUpdateBatchInfo(dialog, uploadBtn);
            } else {
              console.log('[CCA-Bridge] fileInput não encontrado. Deixando o clique fluir para que o NotebookLM acione window.showOpenFilePicker (será interceptado).');
              // NÃO bloqueamos o evento. __armedFiles continua preenchido para o hook do showOpenFilePicker usar.
            }
            return;
          } else {
            console.log('[CCA-Bridge] Botão clicado sem arquivos armados.');
            const fileInput = findAnyFileInput(dialog) || findAnyFileInput(document);
            if (fileInput) {
              __pendingAutoInjectOnClick = true;
              window.postMessage({ type: 'CCA_NLM_REQUEST_ARM', path: __currentBatchInfo.path }, '*');
            } else {
              console.log('[CCA-Bridge] fileInput não existe. Não podemos armar tardiamente sem perder o gesto do usuário para showOpenFilePicker. Deixando fluir.');
            }
            return;
          }
        },
        true
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
            __pendingAutoInjectOnClick = false;
            updateArmedDataset(false);
            __autoUploadCancelledMomentarily = false;
            __currentBatchInfo.isCancelled = false;
            if (document.documentElement.dataset) {
              document.documentElement.dataset.ccaNlmCancelled = '0';
            }
            const bar = dialog.querySelector('#cca-nlm-batch-info-container');
            if (bar) bar.remove();
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
          __pendingAutoInjectOnClick = false;
          updateArmedDataset(false);
          __autoUploadCancelledMomentarily = false;
          __currentBatchInfo.isCancelled = false;
          if (document.documentElement.dataset) {
            document.documentElement.dataset.ccaNlmCancelled = '0';
          }
          const bar = dialog.querySelector('#cca-nlm-batch-info-container');
          if (bar) bar.remove();
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
      if (ev.key === 'Escape') {
        const dialog = getOpenDialog();
        if (dialog) {
          console.log('[CCA-Bridge] Modal fechado pelo usuário via tecla Escape.');
          __armedFiles = null;
          __pendingAutoInjectOnClick = false;
          updateArmedDataset(false);
          __autoUploadCancelledMomentarily = false;
          __currentBatchInfo.isCancelled = false;
          if (document.documentElement.dataset) {
            document.documentElement.dataset.ccaNlmCancelled = '0';
          }
          const bar = dialog.querySelector('#cca-nlm-batch-info-container');
          if (bar) bar.remove();
          clearHighlights();
          window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
        }
      }
    });
  }

  let __lastModalOpenState = false;
  function checkModalOpenState() {
    const dialog = getOpenDialog();
    const isOpen = Boolean(dialog);
    if (isOpen && !__lastModalOpenState) {
      __lastModalOpenState = true;
      console.log('[CCA-Bridge] Modal de fontes detectado como ABERTO.');
      window.postMessage({ type: 'CCA_NLM_MODAL_OPENED' }, '*');
    } else if (!isOpen && __lastModalOpenState) {
      __lastModalOpenState = false;
      console.log('[CCA-Bridge] Modal de fontes detectado como FECHADO.');
      __armedFiles = null;
      __pendingAutoInjectOnClick = false;
      updateArmedDataset(false);
      __autoUploadCancelledMomentarily = false;
      __currentBatchInfo.isCancelled = false;
      if (document.documentElement.dataset) {
        document.documentElement.dataset.ccaNlmCancelled = '0';
      }
      clearHighlights();
      window.postMessage({ type: 'CCA_NLM_MODAL_CLOSED_BY_USER' }, '*');
    }
    if (dialog) {
      ensureModalButtonHighlighted();
    }
  }

  function startHighlightWatcher() {
    stopHighlightWatcher();
    checkModalOpenState();

    let elapsed = 0;
    __highlightWatcherTimer = setInterval(() => {
      elapsed += 250;
      checkModalOpenState();
      if (!getOpenDialog() && elapsed > 60000) {
        stopHighlightWatcher();
      }
    }, 250);

    try {
      __highlightObserver = new MutationObserver(() => {
        checkModalOpenState();
      });
      __highlightObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (_) {}
  }

  function initGlobalModalWatcher() {
    try {
      const globalObs = new MutationObserver(() => {
        checkModalOpenState();
      });
      globalObs.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (_) {}

    setInterval(() => {
      checkModalOpenState();
    }, 400);
  }

  initGlobalModalWatcher();

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

    // 1. Se o modal não estiver aberto, abre o modal de fontes do NotebookLM
    let dialog = getOpenDialog();
    if (!dialog) {
      dialog = await ensureOpenSourcesDialog();
    }

    // 2. Arma o interceptador global no MAIN world
    armInterceptor(webFiles, payload);

    // 3. Inicia o watcher contínuo que busca o botão e o destaca no modal do NotebookLM
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
        curDialog = await ensureOpenSourcesDialog();
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
