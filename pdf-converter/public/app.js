/* ============================================================
   PDF Report Converter — Frontend Application
   Steps 1-3: Upload → Processing → Confirmation
   ============================================================ */

'use strict';

const API = '/api';
let currentJobId = null;
let currentFile   = null;
let pollTimer     = null;
let structure     = null;   // The current (editable) structure

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

    // Store confirmed structure and signal ready for Step 4
    structure = confirmed;
    showReportReadyNotice();

  } catch (err) {
    alert('Error confirming structure: ' + err.message);
    [btn1, btn2].forEach(b => { if (b) { b.disabled = false; b.textContent = 'Confirm & Generate Report'; } });
  }
}

function showReportReadyNotice() {
  // For now, show a friendly message in the confirm step.
  // Step 4 (report generation & display) will be implemented in the next phase.
  const actions = document.querySelectorAll('.confirm-actions');
  actions.forEach(el => {
    el.innerHTML = `
      <div style="text-align:center;padding:2rem;background:var(--green-100);border-radius:var(--radius-lg);width:100%;max-width:520px;">
        <div style="font-size:3rem;margin-bottom:1rem;">✅</div>
        <h3 style="color:var(--green-600);font-size:1.3rem;margin-bottom:.5rem;">Structure Confirmed!</h3>
        <p style="color:var(--gray-600);margin-bottom:1.5rem;">
          Your document structure has been saved. Report generation (Step 4) will be available shortly.
        </p>
        <button onclick="location.reload()" class="btn-ghost">Start Over</button>
      </div>
    `;
  });

  // Disable confirm buttons in header
  const topBtn = $('btn-confirm-top');
  if (topBtn) { topBtn.disabled = true; topBtn.textContent = '✓ Confirmed'; }
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
