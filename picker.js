// picker.js — Chat Continue Auto
// Roda no contexto da extensão (chrome-extension://<id>/picker.html)
// Salva o handle da pasta raiz no IndexedDB da extensão e notifica as abas.

const DB_NAME = 'ChatContinueDB';
const DB_VERSION = 1;
const STORE = 'handles';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveHandle(rootHandle) {
  const idb = await openIDB();
  const tx = idb.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.put({ id: 'root', handle: rootHandle });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

const btn = document.getElementById('btn');
const status = document.getElementById('status');

btn.addEventListener('click', async () => {
  try {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('A File System Access API está desativada. No Brave, acesse brave://flags/#file-system-access-api, marque "Enabled" e reinicie o navegador.');
    }

    status.textContent = 'Selecionando pasta...';
    status.style.display = 'block';
    status.classList.remove('error');

    const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    // Salva no IndexedDB interno da extensão
    await saveHandle(rootHandle);

    // Salva também o nome e timestamp em chrome.storage.local
    await chrome.storage.local.set({
      ccaRootFolderName: rootHandle.name,
      ccaRootConnectedAt: Date.now()
    });

    status.textContent = 'Conectado com sucesso: ' + rootHandle.name;
    chrome.runtime.sendMessage({ type: 'cca-picker-done', name: rootHandle.name });

    setTimeout(() => window.close(), 1200);
  } catch (e) {
    if (e.name === 'AbortError') return;
    status.textContent = 'Erro: ' + e.message;
    status.classList.add('error');
    status.style.display = 'block';
    if (/file system access|desativada|permiss|denied/i.test(e.message)) {
      setLinuxBoxVisible(true);
    }
  }
});

// --- Ajuda Linux / Flatpak / Brave ---
const btnLinuxInfo = document.getElementById('btnLinuxInfo');
const linuxInfoBox = document.getElementById('linuxInfoBox');
const btnCloseInfo = document.getElementById('btnCloseInfo');

function setLinuxBoxVisible(show) {
  if (!linuxInfoBox) return;
  linuxInfoBox.style.display = show ? 'block' : 'none';
  if (show) {
    linuxInfoBox.scrollIntoView({ behavior: 'smooth' });
  }
}

if (btnLinuxInfo) {
  btnLinuxInfo.addEventListener('click', () => {
    const isVisible = linuxInfoBox.style.display === 'block';
    setLinuxBoxVisible(!isVisible);
  });
}

if (btnCloseInfo) {
  btnCloseInfo.addEventListener('click', () => {
    setLinuxBoxVisible(false);
  });
}

// Botões de cópia com feedback
document.querySelectorAll('.btn-copy[data-copy]').forEach((btnCopy) => {
  btnCopy.addEventListener('click', async () => {
    const textToCopy = btnCopy.getAttribute('data-copy');
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      const originalText = btnCopy.textContent;
      btnCopy.textContent = '✓ Copiado!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = originalText;
        btnCopy.classList.remove('copied');
      }, 1500);
    } catch (err) {
      console.error('Falha ao copiar:', err);
    }
  });
});
