(() => {
  const labelEl = document.getElementById('label');

  function setFavicons(sourceCanvas) {
    document.querySelectorAll('link[rel*="icon"]').forEach((el) => el.remove());
    for (const size of [16, 32, 48, 128]) {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sourceCanvas, 0, 0, size, size);
      const link = document.createElement('link');
      link.rel = size === 32 ? 'shortcut icon' : 'icon';
      link.type = 'image/png';
      link.sizes = `${size}x${size}`;
      link.href = c.toDataURL('image/png');
      document.head.appendChild(link);
    }
  }

  function paintBadge(img, label, isAlert = false) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const bannerH = Math.round(size * 0.44);
    const y = size - bannerH;
    ctx.fillStyle = isAlert ? '#d97706' : '#e11d48';
    ctx.fillRect(0, y, size, bannerH);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fontSize = isAlert ? Math.round(bannerH * 0.85) : Math.round(bannerH * 0.7);
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    while (fontSize > 18 && ctx.measureText(label).width > size - 10) {
      fontSize -= 1;
      ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    }
    ctx.fillText(label, size / 2, y + bannerH / 2 + 1);
    return canvas;
  }

  async function apply(progress) {
    const isAlert =
      progress?.kind === 'alert' || new URLSearchParams(location.search).get('alert') === '1';
    const completed = Math.max(0, Number(progress?.completed) || 0);
    const total = Math.max(completed, Number(progress?.total) || completed);
    const label = isAlert ? '!' : `${Math.max(1, completed)}/${Math.max(1, total)}`;
    document.title = isAlert ? '⚠ Alerta' : label;
    if (labelEl) labelEl.textContent = label;
    try {
      if (typeof navigator.setAppBadge === 'function') {
        navigator.setAppBadge(isAlert ? 1 : Math.max(1, completed)).catch(() => {});
      }
    } catch {
      // ignore
    }
    try {
      const img = new Image();
      img.src = chrome.runtime.getURL('icons/icon128.png');
      await img.decode();
      setFavicons(paintBadge(img, label, isAlert));
    } catch {
      if (progress?.iconUrl) {
        const link = document.createElement('link');
        link.rel = 'icon';
        link.href = progress.iconUrl;
        document.head.appendChild(link);
      }
    }
  }

  const params = new URLSearchParams(location.search);
  if (params.has('alert')) {
    void apply({ kind: 'alert' });
  } else if (params.has('c') || params.has('t')) {
    void apply({
      completed: Number(params.get('c') || 1),
      total: Number(params.get('t') || 1),
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cca-progress-icon') void apply(msg);
  });

  chrome.runtime.sendMessage({ type: 'cca-get-progress' }, (res) => {
    if (res?.ok) void apply(res);
  });
})();
