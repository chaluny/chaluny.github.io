/* ============================================================
   PDF Report Converter — Frontend Application
   Steps 1-3: Upload → Processing → Confirmation
   ============================================================ */

'use strict';

const API = '/api';
let currentJobId   = null;
let currentFile    = null;
let pollTimer      = null;
let structure      = null;   // Original AI-analyzed structure (for content + figure metadata)
let confirmedData  = null;   // User-confirmed structure

/* ============================================================
   UTILITY HELPERS
   ============================================================ */

const $ = id => document.getElementById(id);

function showStep(stepId) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(stepId);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}

function showError(elementId, message) {
  const el = $(elementId);
  if (el) { el.textContent = message; el.classList.remove('hidden'); }
}

function hideError(elementId) {
  const el = $(elementId);
  if (el) el.classList.add('hidden');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ============================================================
   STEP 1 — UPLOAD
   ============================================================ */

const dropZone   = $('drop-zone');
const fileInput  = $('file-input');
const fileInfo   = $('file-info');
const btnProcess = $('btn-process');

// Drag and drop
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setSelectedFile(fileInput.files[0]);
});

$('btn-remove-file').addEventListener('click', e => {
  e.stopPropagation();
  clearSelectedFile();
});

function setSelectedFile(file) {
  if (file.type !== 'application/pdf') {
    showError('upload-error', 'Please select a valid PDF file.');
    return;
  }
  hideError('upload-error');
  currentFile = file;

  $('file-name-display').textContent = file.name;
  $('file-meta-display').textContent = formatFileSize(file.size);

  dropZone.classList.add('hidden');
  fileInfo.classList.remove('hidden');
  btnProcess.disabled = false;
}

function clearSelectedFile() {
  currentFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  btnProcess.disabled = true;
  hideError('upload-error');
}

btnProcess.addEventListener('click', async () => {
  if (!currentFile) return;
  await uploadFile(currentFile);
});

async function uploadFile(file) {
  hideError('upload-error');
  btnProcess.disabled = true;
  btnProcess.textContent = 'Uploading...';

  const formData = new FormData();
  formData.append('pdf', file);

  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    currentJobId = data.jobId;

    // Transition to processing step
    $('processing-filename').textContent = file.name;
    showStep('step-processing');
    startPolling(data);

  } catch (err) {
    btnProcess.disabled = false;
    btnProcess.innerHTML = 'Process Document <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 9h10M10 5l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    showError('upload-error', 'Upload failed: ' + err.message);
  }
}

/* ============================================================
   STEP 2 — PROCESSING / POLLING
   ============================================================ */

const progressSteps = {
  extract:  $('pstep-extract'),
  analyze:  $('pstep-analyze'),
  figures:  $('pstep-figures'),
  finalize: $('pstep-finalize')
};

function updateProgressUI(progress, label) {
  const bar = $('progress-bar');
  if (bar) bar.style.width = `${progress}%`;
  const lbl = $('progress-label');
  if (lbl) lbl.textContent = label;

  // Map progress ranges to steps
  setProgressStep('extract',  progress >= 10, progress < 40);
  setProgressStep('analyze',  progress >= 40, progress < 70);
  setProgressStep('figures',  progress >= 70, progress < 90);
  setProgressStep('finalize', progress >= 90, progress < 100);
}

function setProgressStep(key, done, active) {
  const el = progressSteps[key];
  if (!el) return;
  el.classList.toggle('done', done && !active);
  el.classList.toggle('active', active);
  const indicator = el.querySelector('.pstep-indicator');
  if (indicator) indicator.textContent = done && !active ? '' : '';
}

function startPolling(initialData) {
  updateProgressUI(10, 'Extracting PDF content...');

  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API}/job/${currentJobId}/status`);
      const data = await res.json();

      updateProgressUI(data.progress || 10, data.progressStep || '');

      if (data.status === 'analyzed') {
        clearInterval(pollTimer);
        updateProgressUI(100, 'Analysis complete!');
        setTimeout(() => loadStructure(), 600);
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        handleProcessingError(data.error || 'Unknown error during processing');
      }
    } catch (err) {
      console.warn('Polling error:', err);
    }
  }, 1500);
}

function handleProcessingError(message) {
  // Go back to upload with error
  showStep('step-upload');
  btnProcess.disabled = false;
  btnProcess.innerHTML = 'Process Document <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 9h10M10 5l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  showError('upload-error', 'Processing failed: ' + message);
}

async function loadStructure() {
  try {
    const res = await fetch(`${API}/job/${currentJobId}/structure`);
    if (!res.ok) throw new Error('Failed to load structure');
    structure = await res.json();
    buildConfirmationUI(structure);
    showStep('step-confirm');
  } catch (err) {
    handleProcessingError(err.message);
  }
}

/* ============================================================
   STEP 3 — CONFIRMATION UI
   ============================================================ */

function buildConfirmationUI(doc) {
  // Title
  $('doc-title-input').value = doc.title || '';

  // Build structure tree (left panel)
  buildStructureTree(doc.chapters);

  // Build review cards (right panel)
  buildReviewCards(doc.chapters);
}

/* ---- LEFT: structure tree ---- */

function buildStructureTree(chapters) {
  const tree = $('structure-tree');
  tree.innerHTML = '';

  chapters.forEach((ch, ci) => {
    const chDiv = document.createElement('div');
    chDiv.className = 'tree-chapter';
    chDiv.dataset.chapterId = ch.id;

    const header = document.createElement('div');
    header.className = 'tree-chapter-header';
    header.innerHTML = `
      <span class="tree-toggle">▶</span>
      <span class="tree-ch-label">${escHtml(ch.title)}</span>
    `;
    header.addEventListener('click', () => {
      const subs = chDiv.querySelector('.tree-subs');
      const toggle = header.querySelector('.tree-toggle');
      const isOpen = subs.classList.toggle('open');
      toggle.classList.toggle('open', isOpen);
      // Scroll review card into view
      scrollToCard(`ch-card-${ch.id}`);
    });

    const subsDiv = document.createElement('div');
    subsDiv.className = 'tree-subs';

    (ch.subchapters || []).forEach(sub => {
      const subEl = document.createElement('div');
      subEl.className = 'tree-sub';
      subEl.dataset.subId = sub.id;
      subEl.textContent = sub.title;
      subEl.addEventListener('click', e => {
        e.stopPropagation();
        scrollToCard(`sub-card-${sub.id}`);
      });
      subsDiv.appendChild(subEl);
    });

    chDiv.appendChild(header);
    chDiv.appendChild(subsDiv);
    tree.appendChild(chDiv);
  });
}

function scrollToCard(cardId) {
  const el = document.getElementById(cardId);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---- RIGHT: review cards ---- */

function buildReviewCards(chapters) {
  const container = $('review-chapters');
  container.innerHTML = '';

  chapters.forEach((ch, ci) => {
    const card = buildChapterCard(ch, ci);
    container.appendChild(card);
  });
}

function buildChapterCard(ch, ci) {
  const card = document.createElement('div');
  card.className = 'chapter-review-card';
  card.id = `ch-card-${ch.id}`;

  // Header
  const header = document.createElement('div');
  header.className = 'chapter-review-header';
  header.innerHTML = `
    <div class="chapter-number">${ci + 1}</div>
    <input type="text"
           class="chapter-title-input"
           value="${escAttr(ch.title)}"
           placeholder="Chapter title"
           data-chapter-id="${ch.id}"
           aria-label="Chapter title" />
    <div class="chapter-actions">
      <button class="btn-icon danger" title="Delete chapter" data-action="delete-chapter" data-chapter-id="${ch.id}">🗑</button>
    </div>
  `;

  // Body
  const body = document.createElement('div');
  body.className = 'chapter-review-body';

  // Chapter summary
  const summaryBox = document.createElement('div');
  summaryBox.className = 'summary-box';
  summaryBox.innerHTML = `
    <div class="summary-box-header">
      <span class="summary-box-label">📝 AI Summary</span>
    </div>
    <textarea class="summary-textarea"
              data-chapter-id="${ch.id}"
              aria-label="Chapter summary"
              placeholder="Enter a summary for this chapter...">${escHtml(ch.summary)}</textarea>
  `;

  // Sub-chapters
  const subList = document.createElement('div');
  subList.className = 'subchapter-list';

  (ch.subchapters || []).forEach(sub => {
    subList.appendChild(buildSubchapterCard(sub, ch.id));
  });

  // Add sub-chapter button
  const addSubBtn = document.createElement('button');
  addSubBtn.className = 'btn-ghost btn-sm';
  addSubBtn.style.alignSelf = 'flex-start';
  addSubBtn.textContent = '+ Add sub-chapter';
  addSubBtn.addEventListener('click', () => addSubchapter(ch.id, subList));

  body.appendChild(summaryBox);
  body.appendChild(subList);
  body.appendChild(addSubBtn);

  card.appendChild(header);
  card.appendChild(body);

  // Wire delete chapter
  header.querySelector('[data-action="delete-chapter"]').addEventListener('click', () => {
    if (confirm('Delete this chapter?')) {
      card.remove();
      // Remove from tree
      const treeItem = document.querySelector(`[data-chapter-id="${ch.id}"].tree-chapter`);
      if (treeItem) treeItem.remove();
    }
  });

  return card;
}

function buildSubchapterCard(sub, chapterId) {
  const card = document.createElement('div');
  card.className = 'subchapter-card';
  card.id = `sub-card-${sub.id}`;

  const headerEl = document.createElement('div');
  headerEl.className = 'subchapter-card-header';
  headerEl.innerHTML = `
    <input type="text"
           class="sub-title-input"
           value="${escAttr(sub.title)}"
           placeholder="Sub-chapter title"
           aria-label="Sub-chapter title"
           data-sub-id="${sub.id}" />
    <button class="btn-icon danger" title="Delete" data-action="delete-sub">🗑</button>
  `;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'subchapter-card-body';
  bodyEl.innerHTML = `
    <label class="card-label">Summary</label>
    <textarea class="sub-summary-textarea"
              placeholder="Sub-chapter summary..."
              data-sub-id="${sub.id}"
              aria-label="Sub-chapter summary">${escHtml(sub.summary)}</textarea>
  `;

  // Figures
  if (sub.figures && sub.figures.length > 0) {
    const figsSection = document.createElement('div');
    figsSection.className = 'figures-section';
    figsSection.innerHTML = `<p class="figures-header">Detected Figures</p>`;
    const figCards = document.createElement('div');
    figCards.className = 'figure-cards';

    sub.figures.forEach(fig => {
      figCards.appendChild(buildFigureCard(fig));
    });

    figsSection.appendChild(figCards);
    bodyEl.appendChild(figsSection);
  }

  card.appendChild(headerEl);
  card.appendChild(bodyEl);

  headerEl.querySelector('[data-action="delete-sub"]').addEventListener('click', () => {
    if (confirm('Delete this sub-chapter?')) card.remove();
  });

  return card;
}

function buildFigureCard(fig) {
  const confidence = fig.confidence ?? 0.5;
  const confClass  = confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'mid' : 'low';
  const confLabel  = Math.round(confidence * 100) + '%';
  const needsInput = confidence < 0.5;

  const typeEmoji = { chart: '📊', table: '📋', image: '🖼', unknown: '❓' }[fig.type] || '❓';

  const card = document.createElement('div');
  card.className = 'figure-card';
  card.id = `fig-card-${fig.id}`;

  card.innerHTML = `
    <div class="figure-card-banner ${needsInput ? 'needs-input' : ''}">
      <span>${typeEmoji} ${capitalise(fig.type)} — Page ${fig.page}</span>
      <div style="display:flex;gap:.5rem;align-items:center;">
        ${needsInput ? '<span class="needs-input-badge">⚠ Needs your input</span>' : ''}
        <span class="confidence-badge ${confClass}">Confidence: ${confLabel}</span>
      </div>
    </div>
    <div class="figure-card-content">
      <div class="figure-thumbnail">
        ${fig.imageSrc
          ? `<img src="${escAttr(fig.imageSrc)}" alt="Figure page ${fig.page}" loading="lazy" />`
          : typeEmoji}
      </div>
      <div class="figure-details">
        <p class="figure-caption">${escHtml(fig.caption)}</p>
        <p class="figure-meta">Page ${fig.page} · ${capitalise(fig.type)}</p>
        <p class="figure-interp-label">AI Interpretation</p>
        <textarea class="figure-interp-textarea"
                  data-fig-id="${fig.id}"
                  aria-label="Figure interpretation">${escHtml(fig.interpretation)}</textarea>
      </div>
    </div>
  `;

  return card;
}

function addSubchapter(chapterId, subListEl) {
  const newSub = {
    id: `${chapterId}-sub-${Date.now()}`,
    title: 'New Sub-chapter',
    pages: [1, 1],
    summary: '',
    content: '',
    figures: []
  };
  subListEl.appendChild(buildSubchapterCard(newSub, chapterId));
  // Focus the new title input
  const newCard = subListEl.lastElementChild;
  const input = newCard.querySelector('.sub-title-input');
  if (input) { input.focus(); input.select(); }
}

/* ---- Add chapter button ---- */

$('btn-add-chapter').addEventListener('click', () => {
  const ch = {
    id: `ch-${Date.now()}`,
    title: 'New Chapter',
    pages: [1, 1],
    summary: '',
    subchapters: []
  };
  // Add to structure
  if (!structure.chapters) structure.chapters = [];
  structure.chapters.push(ch);

  // Add to tree
  buildStructureTree(structure.chapters);

  // Add card
  const container = $('review-chapters');
  const card = buildChapterCard(ch, structure.chapters.length - 1);
  container.appendChild(card);
  scrollToCard(`ch-card-${ch.id}`);
});

/* ============================================================
   CONFIRM BUTTONS — collect edits and submit
   ============================================================ */

function collectStructure() {
  const doc = { title: $('doc-title-input').value.trim(), chapters: [] };

  document.querySelectorAll('.chapter-review-card').forEach(chCard => {
    const chId = chCard.querySelector('.chapter-title-input').dataset.chapterId;
    const ch = {
      id: chId,
      title: chCard.querySelector('.chapter-title-input').value.trim(),
      summary: chCard.querySelector('.summary-textarea').value.trim(),
      subchapters: []
    };

    chCard.querySelectorAll('.subchapter-card').forEach(subCard => {
      const subTitleInput = subCard.querySelector('.sub-title-input');
      const subSummaryTA  = subCard.querySelector('.sub-summary-textarea');
      const sub = {
        id: subTitleInput ? subTitleInput.dataset.subId : `sub-${Date.now()}`,
        title:   subTitleInput ? subTitleInput.value.trim() : '',
        summary: subSummaryTA  ? subSummaryTA.value.trim()  : '',
        figures: []
      };

      subCard.querySelectorAll('.figure-interp-textarea').forEach(ta => {
        sub.figures.push({
          id: ta.dataset.figId,
          interpretation: ta.value.trim()
        });
      });

      ch.subchapters.push(sub);
    });

    doc.chapters.push(ch);
  });

  return doc;
}

async function confirmStructure() {
  const confirmed = collectStructure();

  const btn1 = $('btn-confirm-top');
  const btn2 = $('btn-confirm-bottom');
  [btn1, btn2].forEach(b => { if (b) { b.disabled = true; b.textContent = 'Confirming...'; } });

  try {
    const res = await fetch(`${API}/job/${currentJobId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structure: confirmed })
    });

    if (!res.ok) throw new Error('Failed to confirm structure');

    buildAndShowReport(confirmed);

  } catch (err) {
    alert('Error confirming structure: ' + err.message);
    [btn1, btn2].forEach(b => { if (b) { b.disabled = false; b.textContent = 'Confirm & Generate Report'; } });
  }
}


$('btn-confirm-top').addEventListener('click', confirmStructure);
$('btn-confirm-bottom').addEventListener('click', confirmStructure);

/* ============================================================
   HELPERS
   ============================================================ */

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function capitalise(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ============================================================
   STEP 4 — REPORT VIEWER
   ============================================================ */

function buildAndShowReport(confirmed) {
  confirmedData  = confirmed;
  const figIndex = buildFigureIndex(structure);
  const subIndex = buildSubIndex(structure);

  $('report-nav-title').textContent = confirmed.title || 'Report';

  const toc     = $('report-toc');
  const content = $('report-content');
  toc.innerHTML     = '';
  content.innerHTML = '';

  const sectionEls = [];

  // Cover
  const cover = document.createElement('div');
  cover.className = 'report-cover';
  cover.innerHTML = `<h1 class="report-doc-title">${escHtml(confirmed.title || 'Document Report')}</h1>`;
  content.appendChild(cover);

  (confirmed.chapters || []).forEach((ch, ci) => {
    // TOC — chapter
    const tocCh = document.createElement('div');
    tocCh.className = 'toc-chapter';
    tocCh.dataset.target = `section-ch-${ch.id}`;
    tocCh.innerHTML = `
      <span class="toc-ch-num">${ci + 1}</span>
      <span class="toc-ch-label">${escHtml(ch.title)}</span>
    `;
    tocCh.addEventListener('click', () => scrollReportTo(`section-ch-${ch.id}`));
    toc.appendChild(tocCh);

    // Chapter section
    const chSection = document.createElement('section');
    chSection.id = `section-ch-${ch.id}`;
    chSection.className = 'report-chapter';

    chSection.innerHTML = `
      <div class="chapter-eyebrow">Chapter ${ci + 1}</div>
      <h2 class="chapter-heading">${escHtml(ch.title)}</h2>
    `;

    if (ch.summary) {
      chSection.insertAdjacentHTML('beforeend', `
        <div class="section-label">Summary</div>
        <div class="chapter-summary">${formatSummaryParagraphs(ch.summary)}</div>
      `);
    }

    sectionEls.push({ el: chSection, id: chSection.id });

    // Subchapters
    (ch.subchapters || []).forEach(sub => {
      // TOC — sub
      const tocSub = document.createElement('div');
      tocSub.className = 'toc-sub';
      tocSub.dataset.target = `section-sub-${sub.id}`;
      tocSub.textContent = sub.title;
      tocSub.addEventListener('click', () => scrollReportTo(`section-sub-${sub.id}`));
      toc.appendChild(tocSub);

      // Subchapter section
      const subSection = document.createElement('section');
      subSection.id = `section-sub-${sub.id}`;
      subSection.className = 'report-subchapter';

      subSection.innerHTML = `<h3 class="subchapter-heading">${escHtml(sub.title)}</h3>`;

      if (sub.summary) {
        subSection.insertAdjacentHTML('beforeend', `
          <div class="section-label">Summary</div>
          <div class="subchapter-summary">${formatSummaryParagraphs(sub.summary)}</div>
        `);
      }

      // Full extracted text
      const origSub = subIndex[sub.id] || {};
      if (origSub.content) {
        const bodyHtml = formatBodyText(origSub.content);
        if (bodyHtml) {
          subSection.insertAdjacentHTML('beforeend', `
            <div class="section-label full-text-label">Full text</div>
            <div class="section-full-text">${bodyHtml}</div>
          `);
        }
      }

      // Figures
      const figs = sub.figures || [];
      if (figs.length > 0) {
        const figContainer = document.createElement('div');
        figContainer.className = 'figure-callouts';
        let hasVisible = false;

        figs.forEach(figRef => {
          const orig     = figIndex[figRef.id] || {};
          const type     = orig.type || 'unknown';
          const emoji    = { chart: '📊', table: '📋', image: '🖼', unknown: '❓' }[type] || '❓';
          const caption  = orig.caption || '';
          const page     = orig.page;
          const interp   = figRef.interpretation || orig.interpretation || '';
          const imageSrc = orig.imageSrc || '';

          if (!caption && !interp && !imageSrc) return;
          hasVisible = true;

          const imgHtml = imageSrc ? `
            <a class="figure-page-image" href="${escAttr(imageSrc)}" target="_blank" rel="noopener" title="Open full page">
              <img src="${escAttr(imageSrc)}" alt="Page ${page}" loading="lazy" />
            </a>` : '';

          const callout = document.createElement('div');
          callout.className = 'figure-callout';
          callout.innerHTML = `
            <div class="figure-callout-icon" aria-hidden="true">${emoji}</div>
            <div class="figure-callout-body">
              <div class="figure-callout-label">${escHtml(capitalise(type))}${page ? ` &middot; Page ${page}` : ''}</div>
              ${caption ? `<p class="figure-callout-caption">${escHtml(caption)}</p>` : ''}
              ${interp  ? `<p class="figure-callout-interp">${escHtml(interp)}</p>`   : ''}
              ${imgHtml}
            </div>
          `;
          figContainer.appendChild(callout);
        });

        if (hasVisible) subSection.appendChild(figContainer);
      }

      chSection.appendChild(subSection);
      sectionEls.push({ el: subSection, id: subSection.id });
    });

    content.appendChild(chSection);
  });

  setupScrollSpy(sectionEls, content);
  showStep('step-report');
}

function buildFigureIndex(doc) {
  const idx = {};
  if (!doc || !doc.chapters) return idx;
  doc.chapters.forEach(ch => {
    (ch.subchapters || []).forEach(sub => {
      (sub.figures || []).forEach(fig => { idx[fig.id] = fig; });
    });
  });
  return idx;
}

function buildSubIndex(doc) {
  const idx = {};
  if (!doc || !doc.chapters) return idx;
  doc.chapters.forEach(ch => {
    (ch.subchapters || []).forEach(sub => { idx[sub.id] = sub; });
  });
  return idx;
}

function formatBodyText(raw) {
  if (!raw) return '';
  // Strip [PAGE N] markers
  const stripped = raw.replace(/\[PAGE \d+\]/g, '');
  // Collect non-empty lines, group into paragraphs on blank lines
  const lines = stripped.split('\n').map(l => l.trim());
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.length === 0) {
      if (current.length > 0) { paragraphs.push(current.join(' ')); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs
    .filter(p => p.length > 5)
    .map(p => `<p>${escHtml(p)}</p>`)
    .join('');
}

function formatSummaryParagraphs(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => `<p>${escHtml(l)}</p>`)
    .join('');
}

function scrollReportTo(sectionId) {
  const target    = document.getElementById(sectionId);
  const container = $('report-content');
  if (!target || !container) return;
  const offset = target.getBoundingClientRect().top
               - container.getBoundingClientRect().top
               + container.scrollTop - 24;
  container.scrollTo({ top: offset, behavior: 'smooth' });
}

function setupScrollSpy(sectionEls, scrollContainer) {
  let activeId = null;

  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    document.querySelectorAll('#report-toc [data-target]').forEach(el => {
      el.classList.toggle('active', el.dataset.target === id);
    });
    if (id) {
      const activeEl = document.querySelector(`#report-toc [data-target="${id}"]`);
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function onScroll() {
    const cTop = scrollContainer.getBoundingClientRect().top;
    let found  = null;
    for (const { el, id } of sectionEls) {
      if (el.getBoundingClientRect().top - cTop <= 80) found = id;
    }
    setActive(found);
  }

  scrollContainer.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(onScroll, 50);
}

async function downloadReportHTML() {
  const btn = $('btn-download-html');
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Preparing…';

  const title    = $('report-nav-title').textContent;
  const figIndex = buildFigureIndex(structure);
  const subIndex = buildSubIndex(structure);

  // Collect all image URLs to embed as base64
  const imageUrls = new Set();
  structure?.chapters?.forEach(ch =>
    ch.subchapters?.forEach(sub =>
      sub.figures?.forEach(fig => { if (fig.imageSrc) imageUrls.add(fig.imageSrc); })
    )
  );
  const imageB64 = {};
  await Promise.all([...imageUrls].map(async url => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const blob = await res.blob();
      imageB64[url] = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = e => r(e.target.result);
        fr.readAsDataURL(blob);
      });
    } catch {}
  }));

  // Build TOC
  const tocHtml = (confirmedData?.chapters || []).map((ch, ci) => {
    const subs = (ch.subchapters || []).map(sub =>
      `<a class="dl-toc-sub" href="#section-ch-${ch.id}-sub-${sub.id}">${escHtml(sub.title)}</a>`
    ).join('');
    return `<a class="dl-toc-ch" href="#section-ch-${ch.id}">
      <span class="dl-num">${ci + 1}</span><span>${escHtml(ch.title)}</span>
    </a>${subs}`;
  }).join('');

  // Build content
  const bodyHtml = (confirmedData?.chapters || []).map((ch, ci) => {
    const subsHtml = (ch.subchapters || []).map(sub => {
      const origSub = subIndex[sub.id] || {};
      const bodyText = origSub.content ? formatBodyText(origSub.content) : '';
      const figsHtml = (sub.figures || []).map(figRef => {
        const orig    = figIndex[figRef.id] || {};
        const type    = orig.type || 'unknown';
        const emoji   = { chart: '📊', table: '📋', image: '🖼', unknown: '❓' }[type] || '❓';
        const caption = orig.caption || '';
        const page    = orig.page;
        const interp  = figRef.interpretation || orig.interpretation || '';
        const rawSrc  = orig.imageSrc || '';
        const imgSrc  = imageB64[rawSrc] || rawSrc;
        if (!caption && !interp && !imgSrc) return '';
        return `<div class="figure-callout">
          <div class="fc-icon">${emoji}</div>
          <div class="fc-body">
            <div class="fc-label">${escHtml(capitalise(type))}${page ? ` · Page ${page}` : ''}</div>
            ${caption ? `<p class="fc-caption">${escHtml(caption)}</p>` : ''}
            ${interp  ? `<p class="fc-interp">${escHtml(interp)}</p>`   : ''}
            ${imgSrc  ? `<img class="fc-img" src="${escAttr(imgSrc)}" alt="Page ${page}" />` : ''}
          </div>
        </div>`;
      }).filter(Boolean).join('');

      return `<section id="section-ch-${ch.id}-sub-${sub.id}" class="dl-sub">
        <h3 class="dl-sub-h">${escHtml(sub.title)}</h3>
        ${sub.summary ? `<div class="dl-label">Summary</div><div class="dl-summary">${formatSummaryParagraphs(sub.summary)}</div>` : ''}
        ${bodyText    ? `<div class="dl-label dl-full-label">Full text</div><div class="dl-body">${bodyText}</div>` : ''}
        ${figsHtml    ? `<div class="dl-figs">${figsHtml}</div>` : ''}
      </section>`;
    }).join('');

    return `<section id="section-ch-${ch.id}" class="dl-chapter">
      <div class="dl-eyebrow">Chapter ${ci + 1}</div>
      <h2 class="dl-ch-h">${escHtml(ch.title)}</h2>
      ${ch.summary ? `<div class="dl-label">Summary</div><div class="dl-ch-summary">${formatSummaryParagraphs(ch.summary)}</div>` : ''}
      ${subsHtml}
    </section>`;
  }).join('');

  const standalone = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;background:#f9fafb;line-height:1.6}
/* Top bar */
.dl-topbar{position:fixed;top:0;left:0;right:0;height:56px;background:white;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;padding:0 1.25rem;gap:.875rem;z-index:200;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.dl-topbar-title{flex:1;font-weight:700;font-size:.95rem;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-hamburger{display:none;flex-direction:column;gap:4px;background:none;border:none;cursor:pointer;padding:.375rem}
.dl-hamburger span{display:block;width:20px;height:2px;background:#374151;border-radius:2px}
/* Layout */
.dl-layout{display:grid;grid-template-columns:256px 1fr;min-height:100vh;padding-top:56px}
/* Sidebar */
.dl-sidebar{position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto;background:white;border-right:1px solid #e5e7eb;padding:1.25rem 0}
.dl-toc-title{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;padding:0 1.25rem .875rem}
a.dl-toc-ch{display:flex;align-items:center;gap:.625rem;padding:.5rem 1.25rem;font-size:.85rem;font-weight:600;color:#4b5563;text-decoration:none;border-left:3px solid transparent;transition:background .15s,color .15s}
a.dl-toc-ch:hover,a.dl-toc-ch.active{background:#eff6ff;color:#1d4ed8;border-left-color:#2563eb}
a.dl-toc-ch.active .dl-num{background:#2563eb;color:white}
.dl-num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;background:#e5e7eb;color:#4b5563;font-size:.7rem;font-weight:700;border-radius:50%;flex-shrink:0;transition:background .15s,color .15s}
a.dl-toc-sub{display:block;padding:.35rem 1.25rem .35rem 2.75rem;font-size:.8rem;color:#9ca3af;text-decoration:none;border-left:3px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s,color .15s}
a.dl-toc-sub:hover,a.dl-toc-sub.active{background:#eff6ff;color:#2563eb;border-left-color:#93c5fd;font-weight:500}
/* Overlay */
.dl-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:199}
.dl-overlay.open{display:block}
/* Main */
.dl-main{padding:3.5rem 4rem;max-width:none}
.dl-cover{max-width:740px;margin-bottom:4rem;padding-bottom:3rem;border-bottom:2px solid #e5e7eb}
.dl-cover h1{font-size:2.25rem;font-weight:800;color:#111827;line-height:1.2}
.dl-chapter{max-width:740px;margin-bottom:4.5rem;padding-bottom:3.5rem;border-bottom:1px solid #f3f4f6}
.dl-chapter:last-child{border-bottom:none}
.dl-eyebrow{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#2563eb;margin-bottom:.625rem}
.dl-ch-h{font-size:1.75rem;font-weight:800;color:#111827;line-height:1.2;margin-bottom:1.25rem}
.dl-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:.375rem;margin-top:1.25rem}
.dl-full-label{margin-top:1.75rem;padding-top:1.25rem;border-top:1px solid #f3f4f6}
.dl-ch-summary,.dl-summary{font-size:1rem;color:#4b5563;line-height:1.8}
.dl-ch-summary p+p,.dl-summary p+p{margin-top:.75rem}
.dl-sub{margin-top:2.5rem;padding-left:1.75rem;border-left:3px solid #e5e7eb}
.dl-sub-h{font-size:1.125rem;font-weight:700;color:#1f2937;margin-bottom:.875rem}
.dl-body{font-size:.925rem;color:#374151;line-height:1.85}
.dl-body p+p{margin-top:.875rem}
.dl-figs{margin-top:1.5rem;display:flex;flex-direction:column;gap:.875rem}
.figure-callout{display:flex;gap:1rem;align-items:flex-start;background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid #bfdbfe;border-radius:8px;padding:1rem 1.25rem}
.fc-icon{font-size:1.5rem;flex-shrink:0;line-height:1;margin-top:.15rem}
.fc-body{flex:1;min-width:0}
.fc-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#2563eb;margin-bottom:.375rem}
.fc-caption{font-size:.9rem;font-weight:600;color:#374151;margin-bottom:.375rem}
.fc-interp{font-size:.875rem;color:#6b7280;line-height:1.6}
.fc-img{display:block;width:100%;height:auto;max-height:420px;object-fit:contain;background:white;border:1px solid #e5e7eb;border-radius:6px;margin-top:.75rem}
/* Mobile */
@media(max-width:700px){
  .dl-hamburger{display:flex}
  .dl-layout{grid-template-columns:1fr}
  .dl-sidebar{position:fixed;top:56px;left:-260px;width:256px;height:calc(100vh - 56px);z-index:200;transition:left .25s;box-shadow:none}
  .dl-sidebar.open{left:0;box-shadow:4px 0 20px rgba(0,0,0,.15)}
  .dl-main{padding:1.5rem}
}
@media print{body{background:white}.dl-topbar,.dl-sidebar,.dl-overlay{display:none}.dl-layout{display:block}.dl-main{padding:0}}
</style>
</head>
<body>
<div class="dl-overlay" id="dl-overlay"></div>
<div class="dl-topbar">
  <button class="dl-hamburger" id="dl-hamburger" aria-label="Toggle navigation">
    <span></span><span></span><span></span>
  </button>
  <span class="dl-topbar-title">${escHtml(title)}</span>
</div>
<div class="dl-layout">
  <nav class="dl-sidebar" id="dl-sidebar">
    <div class="dl-toc-title">Contents</div>
    ${tocHtml}
  </nav>
  <main class="dl-main">
    <div class="dl-cover"><h1>${escHtml(title)}</h1></div>
    ${bodyHtml}
  </main>
</div>
<script>
(function(){
  var ham=document.getElementById('dl-hamburger');
  var nav=document.getElementById('dl-sidebar');
  var ovl=document.getElementById('dl-overlay');
  function open(){nav.classList.add('open');ovl.classList.add('open')}
  function close(){nav.classList.remove('open');ovl.classList.remove('open')}
  ham.addEventListener('click',function(){nav.classList.contains('open')?close():open()});
  ovl.addEventListener('click',close);
  // Close nav on link click (mobile)
  nav.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){
    close();
    var id=a.getAttribute('href').slice(1);
    var el=document.getElementById(id);
    if(el){setTimeout(function(){el.scrollIntoView({behavior:'smooth'})},50)}
  })});
  // Scroll-spy
  var links=document.querySelectorAll('a.dl-toc-ch,a.dl-toc-sub');
  var sections=Array.from(document.querySelectorAll('.dl-chapter,.dl-sub'));
  function spy(){
    var active=null;
    sections.forEach(function(s){if(s.getBoundingClientRect().top<=80)active=s.id});
    links.forEach(function(l){l.classList.toggle('active',l.getAttribute('href')==='#'+active)});
  }
  window.addEventListener('scroll',spy,{passive:true});
  spy();
})();
</script>
</body>
</html>`;

  btn.disabled = false;
  btn.innerHTML = origText;

  const blob = new Blob([standalone], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (title || 'report').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

$('btn-report-back').addEventListener('click', () => showStep('step-confirm'));
$('btn-report-new').addEventListener('click',  () => location.reload());
$('btn-download-html').addEventListener('click', () => downloadReportHTML().catch(console.error));

// Mobile nav hamburger for the live report viewer
$('btn-nav-toggle').addEventListener('click', () => {
  $('report-sidebar').classList.toggle('open');
  $('nav-overlay').classList.toggle('open');
});
$('nav-overlay').addEventListener('click', () => {
  $('report-sidebar').classList.remove('open');
  $('nav-overlay').classList.remove('open');
});
