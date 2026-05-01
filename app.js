/* app.js – GenzKit main application
   Handles: file upload, step navigation, PDF.js preview,
   chunked processing, pdf-lib output generation
*/

const App = (() => {

  /* ── State ──────────────────────────────────────────── */
  const state = {
    currentStep: 1,
    file: null,
    pdfDoc: null,          // PDF.js document
    totalPages: 0,
    selectedPages: [],     // 1-indexed page numbers to include
    settings: {
      invert: false,
      clearBg: false,
      grayscale: false,
      quality: 'high',
      pageNumbers: true,
      docSize: 'a4',
      orientation: 'portrait',
      rows: 3,
      cols: 1
    },
    outputBytes: null,     // processed PDF blob
    processedPageCount: 0,
    startTime: null
  };

  // PDF.js worker setup
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ── Step navigation ─────────────────────────────────── */
  function goToStep(step) {
    if (step < 1 || step > 6) return;
    if (step > 1 && !state.file) {
      Utils.toast('Please upload a PDF first.', 'error');
      return;
    }
    if (step > 2 && state.selectedPages.length === 0) {
      Utils.toast('Please select at least one page.', 'error');
      return;
    }

    // Hide hero on steps > 1
    const hero = document.getElementById('hero-section');
    if (hero) hero.style.display = step === 1 ? 'block' : 'none';

    // Update step circles
    for (let i = 1; i <= 6; i++) {
      const circle = document.getElementById(`step-${i}`);
      if (!circle) continue;
      circle.classList.remove('active', 'completed');
      if (i < step) circle.classList.add('completed');
      else if (i === step) circle.classList.add('active');
    }

    // Hide all sections
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));

    // Show current section
    const sectionMap = {
      1: 'section-upload',
      2: 'section-preview',
      3: 'section-enhance',
      4: 'section-enhance', // reuse enhance panel for format
      5: 'section-processing',
      6: 'section-success'
    };
    const sectionId = sectionMap[step];
    const section = document.getElementById(sectionId);
    if (section) section.classList.add('active');

    state.currentStep = step;

    // Step-specific logic
    if (step === 2) renderPreviewGrid();
    if (step === 3) updateEnhanceBadge();
    if (step === 3) updateLayoutPreview();
  }

  /* ── File handling ───────────────────────────────────── */
  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('upload-zone').classList.add('drag-over');
  }

  function handleDragLeave(e) {
    e.preventDefault();
    document.getElementById('upload-zone').classList.remove('drag-over');
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('upload-zone').classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length) processFile(files[0]);
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) processFile(file);
  }

  function removeFile() {
    state.file = null;
    state.pdfDoc = null;
    state.totalPages = 0;
    state.selectedPages = [];
    state.outputBytes = null;

    // Reset input
    const input = document.getElementById('file-input');
    if (input) input.value = '';

    document.getElementById('file-info').style.display = 'none';
    document.getElementById('size-warning').style.display = 'none';
    document.getElementById('upload-continue').disabled = true;

    goToStep(1);
  }

  async function processFile(file) {
    // Validate PDF
    if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
      Utils.toast('Please upload a valid PDF file.', 'error');
      return;
    }

    // Size warning (> 50 MB)
    const warnEl = document.getElementById('size-warning');
    if (file.size > 50 * 1024 * 1024) {
      document.getElementById('warning-text').textContent =
        `Large file (${Utils.formatBytes(file.size)}) detected. Processing may take longer on mobile.`;
      warnEl.style.display = 'flex';
    } else {
      warnEl.style.display = 'none';
    }

    state.file = file;

    // Show file info
    const infoEl = document.getElementById('file-info');
    infoEl.style.display = 'block';
    document.getElementById('file-name').textContent = Utils.truncateName(file.name);
    document.getElementById('file-meta').textContent =
      Utils.formatBytes(file.size) + ' · Loading pages…';
    document.getElementById('stat-size').textContent = Utils.formatBytes(file.size);
    document.getElementById('stat-pages').textContent = '…';
    document.getElementById('stat-status').textContent = 'Loading';
    document.getElementById('stat-status').className = 'stat-value';

    // Load with PDF.js (just to get page count — don't render yet)
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      state.pdfDoc = pdf;
      state.totalPages = pdf.numPages;
      // Select all pages by default
      state.selectedPages = Array.from({ length: pdf.numPages }, (_, i) => i + 1);

      document.getElementById('stat-pages').textContent = pdf.numPages;
      document.getElementById('file-meta').textContent =
        Utils.formatBytes(file.size) + ' · ' + pdf.numPages + ' pages';
      document.getElementById('stat-status').textContent = 'Ready';
      document.getElementById('stat-status').className = 'stat-value stat-ok';
      document.getElementById('upload-continue').disabled = false;

      // Warn for very large PDFs
      if (pdf.numPages > 100) {
        document.getElementById('warning-text').textContent =
          `${pdf.numPages}-page document detected. Processing batched for performance.`;
        warnEl.style.display = 'flex';
      }

    } catch (err) {
      console.error('PDF load error:', err);
      Utils.toast('Failed to read PDF. The file may be corrupted or password-protected.', 'error');
      document.getElementById('stat-status').textContent = 'Error';
      document.getElementById('stat-status').className = 'stat-value';
      document.getElementById('upload-continue').disabled = true;
      state.file = null;
    }
  }

  /* ── Preview grid ────────────────────────────────────── */
  let previewRenderedPages = new Set();

  function renderPreviewGrid() {
    const grid = document.getElementById('page-grid');
    if (!grid || !state.pdfDoc) return;

    const total = state.totalPages;
    updateSelectedCount();

    // Only rebuild grid if needed
    if (grid.children.length !== total) {
      grid.innerHTML = '';
      previewRenderedPages.clear();

      for (let i = 1; i <= total; i++) {
        const thumb = document.createElement('div');
        thumb.className = `page-thumb${state.selectedPages.includes(i) ? ' selected' : ''}`;
        thumb.dataset.page = i;
        thumb.setAttribute('role', 'listitem');
        thumb.setAttribute('aria-label', `Page ${i}`);
        thumb.onclick = () => togglePage(i);

        // Placeholder
        const ph = document.createElement('div');
        ph.className = 'page-thumb-placeholder';
        ph.textContent = `Page ${i}`;
        ph.id = `ph-${i}`;
        thumb.appendChild(ph);

        // Page number badge
        const badge = document.createElement('span');
        badge.className = 'page-thumb-num';
        badge.textContent = i;
        thumb.appendChild(badge);

        grid.appendChild(thumb);
      }
    }

    // Lazy-render thumbnails using IntersectionObserver
    setupLazyPreview();

    // Update continue button
    document.getElementById('continue-page-count').textContent = state.selectedPages.length;
  }

  function setupLazyPreview() {
    const thumbs = document.querySelectorAll('.page-thumb');
    const batchSize = Utils.isLowEndDevice() ? 2 : 4;

    if (!('IntersectionObserver' in window)) {
      // Fallback: render first few pages
      renderPageThumbs(Array.from({ length: Math.min(8, state.totalPages) }, (_, i) => i + 1));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      const toRender = [];
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const page = parseInt(entry.target.dataset.page);
          if (!previewRenderedPages.has(page)) {
            toRender.push(page);
            observer.unobserve(entry.target);
          }
        }
      });
      if (toRender.length) {
        renderPageThumbs(toRender, batchSize);
      }
    }, { rootMargin: '80px', threshold: 0.01 });

    thumbs.forEach(t => observer.observe(t));
  }

  async function renderPageThumbs(pageNums, batchSize = 4) {
    const chunks = Utils.chunkArray(pageNums, batchSize);
    for (const chunk of chunks) {
      await Promise.all(chunk.map(num => renderOneThumb(num)));
      await Utils.sleep(16); // yield to browser
    }
  }

  async function renderOneThumb(pageNum) {
    if (previewRenderedPages.has(pageNum) || !state.pdfDoc) return;
    previewRenderedPages.add(pageNum);

    const thumbEl = document.querySelector(`[data-page="${pageNum}"]`);
    if (!thumbEl) return;

    try {
      const page = await state.pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 0.3 });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.cssText = 'width:100%;height:100%;object-fit:cover;';

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Remove placeholder, insert canvas
      const ph = thumbEl.querySelector('.page-thumb-placeholder');
      if (ph) ph.remove();
      thumbEl.insertBefore(canvas, thumbEl.firstChild);

      // Release page resources
      page.cleanup();
    } catch (err) {
      console.warn(`Failed to render thumb for page ${pageNum}:`, err);
    }
  }

  function togglePage(num) {
    const idx = state.selectedPages.indexOf(num);
    if (idx > -1) {
      state.selectedPages.splice(idx, 1);
    } else {
      state.selectedPages.push(num);
      state.selectedPages.sort((a, b) => a - b);
    }

    const thumb = document.querySelector(`[data-page="${num}"]`);
    if (thumb) thumb.classList.toggle('selected', state.selectedPages.includes(num));

    updateSelectedCount();
    document.getElementById('continue-page-count').textContent = state.selectedPages.length;
  }

  function selectAllPages() {
    state.selectedPages = Array.from({ length: state.totalPages }, (_, i) => i + 1);
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
    updateSelectedCount();
    document.getElementById('continue-page-count').textContent = state.selectedPages.length;
  }

  function deselectAllPages() {
    state.selectedPages = [];
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
    updateSelectedCount();
    document.getElementById('continue-page-count').textContent = 0;
  }

  function updateSelectedCount() {
    const el = document.getElementById('selected-count');
    if (el) el.textContent = `${state.selectedPages.length} of ${state.totalPages} pages selected`;
  }

  /* ── Enhance badge ───────────────────────────────────── */
  function updateEnhanceBadge() {
    if (!state.file) return;
    document.getElementById('enhance-filename').textContent =
      Utils.truncateName(state.file.name, 30);
    document.getElementById('enhance-size').textContent =
      Utils.formatBytes(state.file.size);
    document.getElementById('enhance-pages').textContent =
      state.selectedPages.length + ' pages';
  }

  /* ── Layout preview ──────────────────────────────────── */
  function updateLayoutPreview() {
    const rows = parseInt(document.getElementById('sel-rows').value) || 3;
    const cols = parseInt(document.getElementById('sel-cols').value) || 1;
    const preview = document.getElementById('layout-preview');
    const label = document.getElementById('layout-preview-label');
    if (!preview) return;

    preview.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    preview.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    preview.innerHTML = '';
    for (let i = 0; i < rows * cols; i++) {
      const cell = document.createElement('div');
      cell.className = 'preview-cell';
      preview.appendChild(cell);
    }

    if (label) label.textContent = `${rows}×${cols} slides per page`;
  }

  /* ── Collect settings from form ──────────────────────── */
  function collectSettings() {
    state.settings = {
      invert: document.getElementById('toggle-invert').checked,
      clearBg: document.getElementById('toggle-clear-bg').checked,
      grayscale: document.getElementById('toggle-grayscale').checked,
      quality: document.querySelector('input[name="quality"]:checked')?.value || 'high',
      pageNumbers: document.querySelector('input[name="pagenumbers"]:checked')?.value === 'yes',
      docSize: document.querySelector('input[name="docsize"]:checked')?.value || 'a4',
      orientation: document.querySelector('input[name="orientation"]:checked')?.value || 'portrait',
      rows: parseInt(document.getElementById('sel-rows').value) || 3,
      cols: parseInt(document.getElementById('sel-cols').value) || 1
    };
  }

  /* ── Start processing ────────────────────────────────── */
  async function startProcessing() {
    collectSettings();

    if (state.selectedPages.length === 0) {
      Utils.toast('No pages selected.', 'error');
      return;
    }
    if (!state.pdfDoc) {
      Utils.toast('No PDF loaded.', 'error');
      return;
    }

    goToStep(5);
    updateProgress(0, 'Loading document…', 'Initializing…');
    state.startTime = Date.now();

    try {
      const outputBytes = await processPDF();
      state.outputBytes = outputBytes;
      showSuccessScreen(outputBytes);
    } catch (err) {
      console.error('Processing failed:', err);
      Utils.toast('Processing failed: ' + (err.message || 'Unknown error'), 'error');
      goToStep(3);
    }
  }

  /* ── Core PDF processing ─────────────────────────────── */
  async function processPDF() {
    const { settings, selectedPages, pdfDoc } = state;
    const s = settings;
    const jpegQuality = Utils.getJpegQuality(s.quality);
    const renderScale = Utils.getRenderScale(s.quality);

    // Determine output page dimensions (A4 = 595.28 x 841.89 pt)
    let outW, outH;
    if (s.docSize === 'a4') {
      outW = s.orientation === 'portrait' ? 595.28 : 841.89;
      outH = s.orientation === 'portrait' ? 841.89 : 595.28;
    }

    // Slides per output page
    const rows = s.rows;
    const cols = s.cols;
    const slidesPerPage = rows * cols;

    // Group selected pages into output pages
    const pageGroups = Utils.chunkArray(selectedPages, slidesPerPage);
    const totalGroups = pageGroups.length;

    // Create output PDF with pdf-lib
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const outDoc = await PDFDocument.create();
    let font;
    if (s.pageNumbers) {
      font = await outDoc.embedFont(StandardFonts.Helvetica);
    }

    // Process groups in batches to avoid UI freeze
    const batchSize = Utils.isLowEndDevice() ? 1 : (Utils.isMobile() ? 2 : 4);
    const batches = Utils.chunkArray(pageGroups, batchSize);

    let processedGroups = 0;

    for (const batch of batches) {
      await Promise.all(batch.map(async (group, batchIdx) => {
        const globalIdx = processedGroups + batchIdx;

        // Render all input pages in this group to a single output canvas
        const { jpegData, canvasW, canvasH } = await renderGroupToCanvas(
          group, pdfDoc, renderScale, rows, cols,
          s.docSize === 'a4' ? outW : null,
          s.docSize === 'a4' ? outH : null,
          { invert: s.invert, clearBg: s.clearBg, grayscale: s.grayscale },
          jpegQuality
        );

        // Embed image in pdf-lib
        const img = await outDoc.embedJpg(jpegData);

        // Add page to output doc
        const page = outDoc.addPage([outW || canvasW / renderScale, outH || canvasH / renderScale]);

        page.drawImage(img, {
          x: 0,
          y: 0,
          width: page.getWidth(),
          height: page.getHeight()
        });

        // Add page number if requested
        if (s.pageNumbers && font) {
          const pageNum = globalIdx + 1;
          const numStr = String(pageNum);
          const fs = 9;
          const tw = font.widthOfTextAtSize(numStr, fs);
          page.drawText(numStr, {
            x: page.getWidth() / 2 - tw / 2,
            y: 10,
            size: fs,
            font,
            color: rgb(0.4, 0.4, 0.4)
          });
        }

        return globalIdx;
      }));

      processedGroups += batch.length;
      const pct = processedGroups / totalGroups;
      const etaStr = Utils.estimateTime(state.startTime, pct);
      updateProgress(
        pct,
        'Processing your document…',
        `Batch ${Math.ceil(processedGroups / batchSize)} · Processed ${processedGroups} of ${totalGroups} output pages`,
        etaStr
      );

      // Yield to browser
      await Utils.sleep(Utils.isMobile() ? 40 : 16);
    }

    updateProgress(0.98, 'Finalizing PDF…', 'Almost done…');
    await Utils.sleep(100);

    const pdfBytes = await outDoc.save();
    return pdfBytes;
  }

  /* ── Render a group of input pages onto one canvas ──── */
  async function renderGroupToCanvas(pageNums, pdfDoc, scale, rows, cols, outW, outH, filterOpts, jpegQuality) {
    // Render first page to determine dimensions
    const firstPage = await pdfDoc.getPage(pageNums[0]);
    const firstVP = firstPage.getViewport({ scale });

    // Each cell size on output canvas
    const cellW = Math.floor((outW ? outW * (scale) : firstVP.width * cols) / cols);
    const cellH = Math.floor((outH ? outH * (scale) : firstVP.height * rows) / rows);

    // Master canvas
    const masterW = cellW * cols;
    const masterH = cellH * rows;

    const master = document.createElement('canvas');
    master.width = masterW;
    master.height = masterH;
    const masterCtx = master.getContext('2d');

    // White background
    masterCtx.fillStyle = '#ffffff';
    masterCtx.fillRect(0, 0, masterW, masterH);

    // Render each page into its cell
    for (let i = 0; i < pageNums.length; i++) {
      const pageNum = pageNums[i];
      const row = Math.floor(i / cols);
      const col = i % cols;

      const cellCanvas = document.createElement('canvas');
      cellCanvas.width = cellW;
      cellCanvas.height = cellH;
      const cellCtx = cellCanvas.getContext('2d');

      try {
        const page = await pdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale });

        // Render PDF page to cellCanvas (fit within cell)
        const fitScale = Math.min(cellW / vp.width, cellH / vp.height);
        const fitVP = page.getViewport({ scale: scale * fitScale });

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.floor(fitVP.width);
        tempCanvas.height = Math.floor(fitVP.height);
        const tempCtx = tempCanvas.getContext('2d');

        await page.render({ canvasContext: tempCtx, viewport: fitVP }).promise;

        // Apply filters to temp canvas
        if (filterOpts.invert || filterOpts.grayscale || filterOpts.clearBg) {
          Utils.applyFilters(tempCtx, tempCanvas.width, tempCanvas.height, filterOpts);
        }

        // Draw centered in cell
        const dx = Math.floor((cellW - tempCanvas.width) / 2);
        const dy = Math.floor((cellH - tempCanvas.height) / 2);

        // White bg for cell
        cellCtx.fillStyle = '#ffffff';
        cellCtx.fillRect(0, 0, cellW, cellH);
        cellCtx.drawImage(tempCanvas, dx, dy);

        // Add thin separator line
        if (rows * cols > 1) {
          masterCtx.strokeStyle = 'rgba(200,200,200,0.5)';
          masterCtx.lineWidth = 1;
        }

        Utils.releaseCanvas(tempCanvas);
        page.cleanup();
      } catch (err) {
        console.warn(`Failed to render page ${pageNum}:`, err);
        cellCtx.fillStyle = '#f5f5f5';
        cellCtx.fillRect(0, 0, cellW, cellH);
        cellCtx.fillStyle = '#999';
        cellCtx.font = '12px sans-serif';
        cellCtx.textAlign = 'center';
        cellCtx.fillText(`Page ${pageNum}`, cellW / 2, cellH / 2);
      }

      // Blit cell onto master
      masterCtx.drawImage(cellCanvas, col * cellW, row * cellH);
      Utils.releaseCanvas(cellCanvas);
    }

    // Export master as JPEG
    const jpegData = await canvasToJpeg(master, jpegQuality);
    const canvasW = masterW;
    const canvasH = masterH;
    Utils.releaseCanvas(master);

    return { jpegData, canvasW, canvasH };
  }

  /* ── Canvas to JPEG ArrayBuffer ──────────────────────── */
  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      }, 'image/jpeg', quality);
    });
  }

  /* ── Update progress UI ──────────────────────────────── */
  function updateProgress(fraction, title, detail, eta) {
    const pct = Math.round(fraction * 100);
    const fill = document.getElementById('progress-fill');
    const glow = document.getElementById('progress-glow');
    const pctEl = document.getElementById('progress-pct');
    const etaEl = document.getElementById('progress-eta');
    const titleEl = document.getElementById('proc-status');
    const detailEl = document.getElementById('proc-detail');
    const wrapEl = document.getElementById('progress-bar-wrap');

    if (fill) fill.style.width = pct + '%';
    if (glow) glow.style.left = `calc(${pct}% - 20px)`;
    if (pctEl) pctEl.textContent = pct + '%';
    if (etaEl) etaEl.textContent = eta || '';
    if (titleEl && title) titleEl.textContent = title;
    if (detailEl && detail) detailEl.textContent = detail;
    if (wrapEl) {
      wrapEl.setAttribute('aria-valuenow', pct);
    }
  }

  /* ── Show success screen ─────────────────────────────── */
  function showSuccessScreen(outputBytes) {
    const fname = state.file
      ? state.file.name.replace(/\.pdf$/i, '') + '_genzkit.pdf'
      : 'enhanced_document.pdf';

    document.getElementById('result-filename').textContent =
      Utils.truncateName(fname, 36);
    document.getElementById('result-orig-size').textContent =
      Utils.formatBytes(state.file?.size || 0);
    document.getElementById('result-final-size').textContent =
      Utils.formatBytes(outputBytes.byteLength);
    document.getElementById('result-pages').textContent =
      Utils.chunkArray(state.selectedPages, state.settings.rows * state.settings.cols).length;

    goToStep(6);
  }

  /* ── Download result ─────────────────────────────────── */
  function downloadResult() {
    if (!state.outputBytes) {
      Utils.toast('No processed file available.', 'error');
      return;
    }
    const fname = state.file
      ? state.file.name.replace(/\.pdf$/i, '') + '_genzkit.pdf'
      : 'enhanced_document.pdf';

    const blob = new Blob([state.outputBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    Utils.toast('Download started!', 'success');
  }

  /* ── Process another ─────────────────────────────────── */
  function processAnother() {
    // Clean up
    if (state.pdfDoc) {
      state.pdfDoc.destroy().catch(() => {});
    }
    state.file = null;
    state.pdfDoc = null;
    state.totalPages = 0;
    state.selectedPages = [];
    state.outputBytes = null;
    previewRenderedPages.clear();

    // Clear page grid
    const grid = document.getElementById('page-grid');
    if (grid) grid.innerHTML = '';

    // Reset file input
    const input = document.getElementById('file-input');
    if (input) input.value = '';

    document.getElementById('file-info').style.display = 'none';
    document.getElementById('size-warning').style.display = 'none';
    document.getElementById('upload-continue').disabled = true;
    document.getElementById('hero-section').style.display = 'block';

    goToStep(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ── Init ────────────────────────────────────────────── */
  function init() {
    // Radio button active-class sync
    document.querySelectorAll('.radio-group').forEach(group => {
      group.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', () => {
          group.querySelectorAll('.radio-row').forEach(row => {
            row.classList.toggle('active', row.querySelector('input')?.checked);
          });
        });
      });
    });

    // btn-toggle active-class sync
    document.querySelectorAll('.btn-toggle-group').forEach(group => {
      group.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', () => {
          group.querySelectorAll('.btn-toggle').forEach(btn => {
            btn.classList.toggle('active', btn.querySelector('input')?.checked);
          });
        });
      });
    });

    // Initial layout preview render
    updateLayoutPreview();

    // Keyboard drag-drop zone
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.currentStep === 2) {
        // allow closing by Escape on preview step
      }
    });

    console.log('GenzKit initialized', Utils.isMobile() ? '(mobile mode)' : '(desktop mode)');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── Public API ──────────────────────────────────────── */
  return {
    goToStep,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    removeFile,
    renderPreviewGrid,
    togglePage,
    selectAllPages,
    deselectAllPages,
    updateLayoutPreview,
    startProcessing,
    downloadResult,
    processAnother
  };

})();
