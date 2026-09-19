// notebooklm-bridge.js — Executado no MAIN world de notebooklm.google.com
// Permite interceptar eventos nativos, manipular protótipos e interagir diretamente
// com a interface do NotebookLM sem barreiras de sandbox do content script.

(function () {
  if (window.__CCA_NLM_BRIDGE_LOADED__) return;
  window.__CCA_NLM_BRIDGE_LOADED__ = true;
  console.log('[CCA-Bridge] Main World Bridge ativo no NotebookLM.');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Interceptadores Globais Armados no MAIN World ──────────────
  let __armedFiles = null;
  let __armedTimer = null;

  function armInterceptor(webFiles) {
    __armedFiles = webFiles;
    clearTimeout(__armedTimer);
    __armedTimer = setTimeout(() => {
      __armedFiles = null;
      console.log('[CCA-Bridge] Interceptador de arquivos desarmado por timeout.');
    }, 45000);

    function clearHighlights() {
      try {
        document.querySelectorAll('.cca-nlm-highlighted-btn').forEach((el) => {
          el.classList.remove('cca-nlm-highlighted-btn');
          el.style.outline = '';
          el.style.boxShadow = '';
        });
      } catch (_) {}
    }

    if (!window.__ccaInputClickHooked) {
      window.__ccaInputClickHooked = true;
      const origInputClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file' && __armedFiles && __armedFiles.length > 0) {
          console.log('[CCA-Bridge] SUCESSO: input[type="file"].click() interceptado!', this);
          clearHighlights();
          const filesToInject = __armedFiles;
          __armedFiles = null;
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
          clearHighlights();
          const filesToInject = __armedFiles;
          __armedFiles = null;
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
          clearHighlights();
          const filesToInject = __armedFiles;
          __armedFiles = null;
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
        if (d.offsetParent === null && d.offsetWidth === 0 && d.offsetHeight === 0) return false;
        const txt = (d.textContent || '').toLowerCase();
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
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return (
      buttons.find((b) => {
        if (b.offsetParent === null && b.offsetWidth === 0) return false;
        const text = (b.textContent + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return (
          text.includes('adicionar fonte') ||
          text.includes('adicionar fontes') ||
          text.includes('add source') ||
          text.includes('add sources') ||
          text.includes('nova fonte') ||
          text.includes('new source')
        );
      }) || document.querySelector('button[aria-label*="fonte" i], button[aria-label*="source" i]')
    );
  }

  function findUploadButton(dialog) {
    const root = dialog || document;

    const excludeTerms = ['drive', 'google drive', 'sites', 'website', 'livros', 'copiado', 'copied', 'pesquisa no google', 'youtube'];
    const isExcluded = (str) => excludeTerms.some((term) => str.includes(term));

    // 1. Busca em botões e elementos com role="button" ou cards clicáveis
    const candidates = Array.from(
      root.querySelectorAll('button, [role="button"], a.mat-button, label, div[tabindex="0"], mat-card, .mat-mdc-button, .mdc-button')
    );
    for (const el of candidates) {
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      const a = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const combined = t + ' ' + a;

      if (isExcluded(combined)) continue;

      if (
        combined.includes('enviar arquivo') ||
        combined.includes('enviar arquivos') ||
        combined.includes('upload file') ||
        combined.includes('upload files') ||
        combined.includes('fazer upload') ||
        combined.includes('upload de arquivo') ||
        combined.includes('upload de arquivos') ||
        (combined.includes('upload') && !combined.includes('drive'))
      ) {
        return el;
      }
    }

    // 2. Busca por texto interno em spans, divs, rótulos ou ícones
    const labels = Array.from(root.querySelectorAll('.mdc-button__label, span, div, p, label, mat-icon'));
    for (const s of labels) {
      if (s.offsetParent === null && s.offsetWidth === 0 && s.offsetHeight === 0) continue;
      const t = (s.textContent || '').trim().toLowerCase();
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
        t.includes('fazer upload') ||
        t.includes('enviar arquivo') ||
        t.includes('upload file') ||
        t.includes('upload de arquivo')
      ) {
        const clickable = s.closest('button, [role="button"], label, div[tabindex="0"], mat-card, .mat-mdc-button, .mdc-button') || s.parentElement || s;
        return clickable;
      }
    }

    return null;
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

  // ─── Execução do Envio como ARQUIVOS ("Enviar arquivos") ─────────

  async function handleUploadFiles(payload) {
    const rawFiles = payload.files || [];
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
      const realFile = new File([content], f.name, {
        type: mime,
        lastModified: f.lastModified || Date.now()
      });
      console.log(`[CCA-Bridge] Preparado File "${realFile.name}" (${realFile.size} bytes, type: "${realFile.type}")`);
      return realFile;
    });

    console.log(
      '[CCA-Bridge] Iniciando envio via "Enviar arquivos" com',
      webFiles.length,
      'arquivo(s):',
      webFiles.map((f) => `${f.name} (${f.size}b)`)
    );

    // 1. Arma o interceptador global no MAIN world
    armInterceptor(webFiles);

    // 2. Garante que o modal de fontes está aberto
    let dialog = getOpenDialog();
    if (!dialog) {
      const addBtn = findAddSourceButton();
      if (addBtn) {
        console.log('[CCA-Bridge] Abrindo modal "Adicionar fontes"...');
        triggerClick(addBtn);
        for (let i = 0; i < 15; i++) {
          await sleep(100);
          dialog = getOpenDialog();
          if (dialog) break;
        }
      }
    }

    if (!dialog) {
      throw new Error('Não foi possível abrir o modal de fontes do NotebookLM.');
    }

    // 3. Se já existir um input[type="file"] no DOM, injeta diretamente nele
    const existingInput = findAnyFileInput(dialog) || findAnyFileInput(document);
    if (existingInput) {
      console.log('[CCA-Bridge] input[type="file"] pré-existente encontrado. Injetando...', existingInput);
      setFilesOnInput(existingInput, webFiles);
      await sleep(1000);
      if (isUploadActive(dialog) || !dialog.isConnected) {
        return {
          ok: true,
          method: 'file_input',
          count: webFiles.length,
          fileNames: webFiles.map((f) => f.name)
        };
      }
    }

    // 4. Localiza o elemento real do botão "Enviar arquivos" (garantindo que seja o <button> e não o <span> interno)
    let uploadBtn = findUploadButton(dialog);
    if (uploadBtn && uploadBtn.tagName.toLowerCase() !== 'button' && uploadBtn.tagName.toLowerCase() !== 'label') {
      uploadBtn = uploadBtn.closest('button, [role="button"], label') || uploadBtn;
    }
    console.log('[CCA-Bridge] Botão "Enviar arquivos" real identificado:', uploadBtn?.tagName, uploadBtn?.className, uploadBtn);

    if (uploadBtn) {
      console.log('[CCA-Bridge] Acionando clique programático em "Enviar arquivos"...');
      triggerClick(uploadBtn);

      // Aguarda até 1s para o clique chamar o hook
      for (let w = 0; w < 10; w++) {
        if (!__armedFiles) {
          // __armedFiles vira null assim que o interceptador é acionado!
          console.log('[CCA-Bridge] Interceptador consumido com sucesso via clique programático!');
          await sleep(1000);
          return {
            ok: true,
            method: 'file_input',
            count: webFiles.length,
            fileNames: webFiles.map((f) => f.name)
          };
        }
        await sleep(100);
      }
    }

    // 5. Tenta simular Drag & Drop na caixa tracejada
    console.log('[CCA-Bridge] Tentando simulação de Drag & Drop na caixa tracejada...');
    const dropZone = findDropZone(dialog) || dialog;
    if (dropZone) {
      simulateFullDragDrop(dropZone, webFiles);
      await sleep(1200);
      if (isUploadActive(dialog) || !dialog.isConnected) {
        console.log('[CCA-Bridge] Upload via Drag & Drop iniciado com sucesso!');
        return {
          ok: true,
          method: 'drag_and_drop',
          count: webFiles.length,
          fileNames: webFiles.map((f) => f.name)
        };
      }
    }

    // 6. Se o clique programático foi bloqueado por segurança do Chromium (isTrusted check):
    // Mantemos o interceptador armado! Destacamos o botão na tela para o usuário dar 1 clique.
    if (uploadBtn) {
      try {
        uploadBtn.classList.add('cca-nlm-highlighted-btn');
        uploadBtn.style.transition = 'all 0.3s ease';
        uploadBtn.style.outline = '3px solid #22c55e';
        uploadBtn.style.outlineOffset = '4px';
        uploadBtn.style.boxShadow = '0 0 20px rgba(34, 197, 94, 0.85)';
        uploadBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
    }

    console.log('[CCA-Bridge] Interceptador permanece armado para clique manual. Botão destacado:', uploadBtn);
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
