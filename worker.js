/* worker.js – GenzKit Web Worker
   Offloads metadata extraction and batching coordination
   from the main thread. Canvas rendering must still happen
   on the main thread (OffscreenCanvas has limited support).

   This worker handles:
   - PDF page count extraction
   - Page selection validation
   - Batch group calculation
   - Progress event coordination
*/

/* ── Message handler ─────────────────────────────────── */
self.onmessage = async function(e) {
  const { type, payload } = e.data;

  switch (type) {

    case 'GET_PAGE_COUNT': {
      /* payload: { buffer: ArrayBuffer } */
      try {
        // We can't use PDF.js here without importScripts easily,
        // so we send a signal back to main thread for actual loading.
        // This worker validates the buffer is a valid PDF (magic bytes).
        const view = new Uint8Array(payload.buffer, 0, 4);
        const magic = String.fromCharCode(...view);
        if (magic !== '%PDF') {
          self.postMessage({ type: 'ERROR', message: 'Not a valid PDF file.' });
          return;
        }
        self.postMessage({ type: 'PDF_VALID', size: payload.buffer.byteLength });
      } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
      }
      break;
    }

    case 'CALCULATE_BATCHES': {
      /* payload: { selectedPages: number[], rows: number, cols: number, batchSize: number } */
      try {
        const { selectedPages, rows, cols, batchSize } = payload;
        const slidesPerOutputPage = rows * cols;

        // Group input pages into output pages
        const pageGroups = [];
        for (let i = 0; i < selectedPages.length; i += slidesPerOutputPage) {
          pageGroups.push(selectedPages.slice(i, i + slidesPerOutputPage));
        }

        // Group output pages into processing batches
        const batches = [];
        for (let i = 0; i < pageGroups.length; i += batchSize) {
          batches.push(pageGroups.slice(i, i + batchSize));
        }

        self.postMessage({
          type: 'BATCHES_READY',
          payload: {
            pageGroups,
            batches,
            totalOutputPages: pageGroups.length,
            totalBatches: batches.length
          }
        });
      } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
      }
      break;
    }

    case 'ESTIMATE_TIME': {
      /* payload: { startTime: number, progress: number } */
      const { startTime, progress } = payload;
      if (progress <= 0) {
        self.postMessage({ type: 'TIME_ESTIMATE', eta: 'Calculating…' });
        return;
      }
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = progress / elapsed;
      const remaining = (1 - progress) / rate;

      let eta;
      if (remaining < 5) eta = 'Almost done…';
      else if (remaining < 60) eta = `~${Math.ceil(remaining)}s remaining`;
      else eta = `~${Math.ceil(remaining / 60)}m remaining`;

      self.postMessage({ type: 'TIME_ESTIMATE', eta });
      break;
    }

    case 'APPLY_FILTERS_WORKER': {
      /* payload: { imageData: ImageData-like, opts } 
         Note: ImageData can be transferred via SharedArrayBuffer for true zero-copy.
         This is a demo implementation — in a real deployment you'd use
         OffscreenCanvas for full canvas operations in the worker.
      */
      try {
        const { data, width, height, opts } = payload;
        const pixelData = new Uint8ClampedArray(data);
        const len = pixelData.length;

        for (let i = 0; i < len; i += 4) {
          let r = pixelData[i];
          let g = pixelData[i + 1];
          let b = pixelData[i + 2];

          if (opts.invert) {
            r = 255 - r;
            g = 255 - g;
            b = 255 - b;
          }

          if (opts.clearBg && opts.invert) {
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum > 200) { r = 255; g = 255; b = 255; }
          } else if (opts.clearBg) {
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum > 235) { r = 255; g = 255; b = 255; }
          }

          if (opts.grayscale) {
            const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            r = g = b = gray;
          }

          pixelData[i] = r;
          pixelData[i + 1] = g;
          pixelData[i + 2] = b;
        }

        // Transfer the buffer back (zero-copy)
        self.postMessage(
          { type: 'FILTERS_DONE', data: pixelData.buffer, width, height },
          [pixelData.buffer]
        );
      } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
      }
      break;
    }

    default:
      self.postMessage({ type: 'ERROR', message: `Unknown message type: ${type}` });
  }
};

self.onerror = function(err) {
  self.postMessage({ type: 'ERROR', message: err.message });
};
