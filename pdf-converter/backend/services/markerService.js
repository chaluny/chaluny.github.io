/**
 * markerService.js — converts PDFs to structured HTML using the marker library.
 *
 * Marker runs local ML models (layout detection, OCR) to produce high-quality
 * typed block output without requiring any LLM or cloud API.
 *
 * Output: our standard { title, chapters } structure where each subchapter
 * has an `htmlContent` field (ready-to-render HTML) and `figures` array.
 */

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Locate the marker_single executable.
 * pip installs scripts into a directory that may not be on Node's PATH,
 * so we ask Python itself where it is via shutil.which.
 */
function findMarkerExecutable() {
  // 1. Try PATH directly (works when pip bin dir is on PATH)
  try {
    execFileSync('marker_single', ['--help'], { stdio: 'ignore' });
    return 'marker_single';
  } catch (_) {}

  // 2. Ask Python where it is
  const pythons = ['python3', 'python'];
  for (const py of pythons) {
    try {
      const result = execFileSync(
        py,
        ['-c', "import shutil, sys; p = shutil.which('marker_single'); sys.stdout.write(p if p else '')"],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (result && fs.existsSync(result)) return result;
    } catch (_) {}
  }

  // 3. Common pip install locations
  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/marker_single',
    path.join(home, '.local/bin/marker_single'),
    path.join(home, 'Library/Python/3.13/bin/marker_single'),
    path.join(home, 'Library/Python/3.12/bin/marker_single'),
    path.join(home, 'Library/Python/3.11/bin/marker_single'),
    path.join(home, 'Library/Python/3.10/bin/marker_single'),
    path.join(home, 'AppData/Roaming/Python/Python313/Scripts/marker_single.exe'),
    path.join(home, 'AppData/Roaming/Python/Python312/Scripts/marker_single.exe'),
    path.join(home, 'AppData/Roaming/Python/Python311/Scripts/marker_single.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    'marker_single not found. Install it with: pip install marker-pdf\n' +
    'Then restart the server.'
  );
}

const MARKER_EXE = (() => {
  try { return findMarkerExecutable(); }
  catch (e) { console.warn('[markerService]', e.message); return null; }
})();

// Block types we want to accumulate as section content
const CONTENT_TYPES = new Set([
  'BlockTypes.Text',
  'BlockTypes.Code',
  'BlockTypes.Table',
  'BlockTypes.TableGroup',
  'BlockTypes.ListGroup',
  'BlockTypes.ListItem',
  'BlockTypes.Equation',
  'BlockTypes.TextInlineMath',
  'BlockTypes.Footnote',
  'BlockTypes.ComplexRegion',
  'BlockTypes.Handwriting',
  'BlockTypes.Form',
]);

// Block types to silently skip (don't include in output)
const SKIP_TYPES = new Set([
  'BlockTypes.TableOfContents',
  'BlockTypes.PageHeader',
  'BlockTypes.PageFooter',
  'BlockTypes.Reference',
]);

/**
 * Convert a PDF file using marker and return { title, chapters }.
 *
 * @param {string} filePath  - Absolute path to the PDF file
 * @param {string} jobId     - Job ID (used for temp dir naming)
 * @param {Function} [onProgress] - Called with (percent, message) during processing
 * @returns {Promise<{ title: string, chapters: Array }>}
 */
async function convertPdfWithMarker(filePath, jobId, onProgress) {
  const outputDir = path.join(os.tmpdir(), `marker_${jobId}`);

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    // marker_single writes to <outputDir>/<stem>/<stem>.json
    const stem = path.basename(filePath, path.extname(filePath));
    const jsonPath = path.join(outputDir, stem, `${stem}.json`);

    onProgress && onProgress(15, 'Analysing layout and text with Marker (may take 1–2 min per page)...');

    await runMarkerCli(filePath, outputDir);

    onProgress && onProgress(78, 'Parsing document structure...');

    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const structure = parseMarkerJson(jsonData, path.basename(filePath));

    return structure;
  } finally {
    // Clean up temp output — images are embedded as base64 so no paths needed
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Run marker_single CLI and resolve when done (or reject on error). */
function runMarkerCli(filePath, outputDir) {
  const exe = MARKER_EXE;
  if (!exe) {
    return Promise.reject(new Error(
      'marker_single not found. Run: pip install marker-pdf  then restart the server.'
    ));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      [
        filePath,
        '--output_format', 'json',
        '--output_dir', outputDir,
      ],
      { timeout: 10 * 60 * 1000 }
    );

    // Forward marker's progress output to the server terminal
    let stderr = '';
    if (child.stdout) child.stdout.pipe(process.stdout);
    if (child.stderr) {
      child.stderr.on('data', chunk => {
        process.stderr.write(chunk);
        stderr += chunk;
      });
    }

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Marker failed (exit ${code})${stderr ? '\n' + stderr.slice(-2000) : ''}`));
      }
    });

    child.on('error', err => {
      reject(new Error(`Marker failed: ${err.message}${stderr ? '\n' + stderr.slice(0, 500) : ''}`));
    });
  });
}

/**
 * Parse the marker JSON output into our { title, chapters } structure.
 *
 * Marker JSON top-level: { children: [pageBlock, ...], metadata: {...} }
 * Each pageBlock: { block_type: "BlockTypes.Page", children: [block, ...], ... }
 */
function parseMarkerJson(data, filename) {
  const title =
    data.metadata?.title ||
    data.metadata?.document_name ||
    filename.replace(/\.pdf$/i, '');

  const chapters = [];
  let chapterIdx = 0;
  let subIdx = 0;
  let figureIdx = 0;
  let currentChapter = null;
  let currentSub = null;

  function ensureChapter() {
    if (!currentChapter) {
      currentChapter = { id: `ch-${chapterIdx++}`, title: '', summary: null, subchapters: [] };
      chapters.push(currentChapter);
    }
  }

  function ensureSub() {
    ensureChapter();
    if (!currentSub) {
      currentSub = newSub('');
      currentChapter.subchapters.push(currentSub);
    }
  }

  function newSub(title) {
    return { id: `sub-${subIdx++}`, title, summary: null, htmlContent: '', content: '', figures: [] };
  }

  function extractImages(block) {
    // Returns the first base64 image found on this block or its children
    const images = block.images || {};
    const keys = Object.keys(images);
    if (keys.length > 0) {
      const data = images[keys[0]];
      return data.startsWith('data:') ? data : `data:image/png;base64,${data}`;
    }
    for (const child of block.children || []) {
      const found = extractImages(child);
      if (found) return found;
    }
    return null;
  }

  function extractCaption(block) {
    for (const child of block.children || []) {
      if (child.block_type === 'BlockTypes.Caption') {
        return (child.html || '').replace(/<[^>]+>/g, '').trim();
      }
    }
    return '';
  }

  function processBlock(block) {
    const type = block.block_type || '';
    const html = (block.html || '').trim();

    if (SKIP_TYPES.has(type)) return;

    if (type === 'BlockTypes.Page') {
      for (const child of block.children || []) processBlock(child);
      return;
    }

    if (type === 'BlockTypes.SectionHeader') {
      const levelMatch = html.match(/<h([1-6])/i);
      const level = levelMatch ? parseInt(levelMatch[1]) : 2;
      const text = html.replace(/<[^>]+>/g, '').trim();

      if (level === 1) {
        currentChapter = { id: `ch-${chapterIdx++}`, title: text, summary: null, subchapters: [] };
        chapters.push(currentChapter);
        currentSub = null;
      } else {
        ensureChapter();
        currentSub = newSub(text);
        currentChapter.subchapters.push(currentSub);
      }
      return;
    }

    // Figure / picture groups — contain the actual image + optional caption
    if (type === 'BlockTypes.FigureGroup' || type === 'BlockTypes.PictureGroup') {
      ensureSub();
      const imageSrc = extractImages(block);
      const caption = extractCaption(block);

      if (imageSrc) {
        const fig = { id: `fig-${figureIdx++}`, caption, imageSrc, confidence: 'high' };
        currentSub.figures.push(fig);
        currentSub.htmlContent +=
          `<figure class="marker-figure">` +
          `<img src="${imageSrc}" alt="${escapeAttr(caption)}" />` +
          (caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '') +
          `</figure>`;
      } else if (html) {
        currentSub.htmlContent += html;
      }
      return;
    }

    // Standalone Figure / Picture leaf blocks
    if (type === 'BlockTypes.Figure' || type === 'BlockTypes.Picture') {
      ensureSub();
      const imageSrc = extractImages(block);
      if (imageSrc) {
        const fig = { id: `fig-${figureIdx++}`, caption: '', imageSrc, confidence: 'high' };
        currentSub.figures.push(fig);
        currentSub.htmlContent +=
          `<figure class="marker-figure"><img src="${imageSrc}" alt="" /></figure>`;
      } else if (html) {
        currentSub.htmlContent += html;
      }
      return;
    }

    // Generic content block
    if (CONTENT_TYPES.has(type) && html) {
      ensureSub();
      currentSub.htmlContent += html;
      return;
    }

    // Compound block not matched above — recurse into children
    if (block.children && block.children.length > 0) {
      for (const child of block.children) processBlock(child);
    }
  }

  for (const pageBlock of data.children || []) {
    processBlock(pageBlock);
  }

  // Remove empty subchapters / chapters
  for (const ch of chapters) {
    ch.subchapters = ch.subchapters.filter(s => s.title || s.htmlContent || s.figures.length > 0);
  }

  return {
    title,
    chapters: chapters.filter(ch => ch.title || ch.subchapters.length > 0),
  };
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { convertPdfWithMarker };
