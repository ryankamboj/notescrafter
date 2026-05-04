/* utils.js – GenzKit helper utilities */

const Utils = (() => {

  /* ── Format file size ─────────────────────────────────── */
  function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  /* ── Device detection ────────────────────────────────── */
  function isMobile() {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && window.innerWidth < 768);
  }

  function isLowEndDevice() {
    // Check for low RAM (navigator.deviceMemory, may not be available everywhere)
    const mem = navigator.deviceMemory;
    if (mem && mem <= 2) return true;
    const cores = navigator.hardwareConcurrency;
    if (cores && cores <= 2) return true;
    return false;
  }

  /* ── Chunk array ─────────────────────────────────────── */
  function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  /* ── Sleep / delay ───────────────────────────────────── */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* ── Idle callback wrapper ───────────────────────────── */
  function idle(fn) {
    if (typeof requestIdleCallback !== 'undefined') {
      return new Promise(resolve => requestIdleCallback(() => resolve(fn())));
    }
    return new Promise(resolve => setTimeout(() => resolve(fn()), 10));
  }

  /* ── Toast notifications ─────────────────────────────── */
  function toast(msg, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
      error:   '✕',
      success: '✓',
      info:    'ℹ'
    };

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span style="flex-shrink:0;font-weight:700">${icons[type] || icons.info}</span><span>${msg}</span>`;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('hiding');
      setTimeout(() => el.remove(), 280);
    }, duration);
  }

  /* ── Truncate filename ───────────────────────────────── */
  function truncateName(name, maxLen = 38) {
    if (name.length <= maxLen) return name;
    const ext = name.lastIndexOf('.');
    const extension = ext > -1 ? name.slice(ext) : '';
    const base = name.slice(0, ext > -1 ? ext : name.length);
    return base.slice(0, maxLen - extension.length - 3) + '…' + extension;
  }

  /* ── Get JPEG quality from setting ──────────────────── */
  function getJpegQuality(setting) {
    const map = { low: 0.72, medium: 0.85, high: 0.95 };
    return map[setting] ?? 0.85;
  }

  /* ── Get render scale based on quality + device ──────── */
  function getRenderScale(quality) {
    if (isLowEndDevice() || isMobile()) {
      return quality === 'low' ? 1.5 : quality === 'medium' ? 2.2 : 3.2;
    }
    return quality === 'low' ? 2.2 : quality === 'medium' ? 3.2 : 4.5;
  }

  /* ── Release canvas memory ───────────────────────────── */
  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, 1, 1);
  }

  /* ── Apply image filter on canvas context ────────────── */
  function applyFilters(ctx, width, height, opts) {
    if (!opts.invert && !opts.grayscale && !opts.clearBg && !opts.darken) return;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const len = data.length;

    for (let i = 0; i < len; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      // Clear background: make near-white pixels fully white
      // and near-black pixels white (for dark-themed slides)
      if (opts.clearBg) {
        const brightness = (r + g + b) / 3;
        // Make very dark pixels (background of dark slides) → white
        if (brightness < 40 && opts.invert) {
          // Will be handled by invert below
        } else if (brightness > 220) {
          // Already light — keep
        }
      }

      // Darken Text
      if (opts.darken) {
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        if (lum < 200) {
          const f = Math.pow(lum / 200, 0.5); 
          r *= f; g *= f; b *= f;
        }
      }

      // Invert
      if (opts.invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }

      // After invert with clearBg: threshold light gray artifacts to pure white
      if (opts.clearBg && opts.invert) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 200) { r = 255; g = 255; b = 255; }
      } else if (opts.clearBg && !opts.invert) {
        // Remove near-white backgrounds
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 235) { r = 255; g = 255; b = 255; }
      }

      // Grayscale
      if (opts.grayscale) {
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        r = g = b = gray;
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /* ── Estimate remaining time ─────────────────────────── */
  function estimateTime(startTime, progress) {
    if (progress <= 0) return 'Calculating…';
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = progress / elapsed;
    const remaining = (1 - progress) / rate;
    if (remaining < 5) return 'Almost done…';
    if (remaining < 60) return `~${Math.ceil(remaining)}s remaining`;
    return `~${Math.ceil(remaining / 60)}m remaining`;
  }

  return {
    formatBytes,
    isMobile,
    isLowEndDevice,
    chunkArray,
    sleep,
    idle,
    toast,
    truncateName,
    getJpegQuality,
    getRenderScale,
    releaseCanvas,
    applyFilters,
    estimateTime
  };
})();
