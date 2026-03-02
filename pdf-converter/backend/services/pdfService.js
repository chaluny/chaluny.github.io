const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

/**
 * Extracts text content and images from a PDF file.
 * Images are extracted page-by-page using pdf2pic when available.
 */
async function extractPdfContent(filePath, jobId) {
  const dataBuffer = fs.readFileSync(filePath);

  // Extract text with page-level metadata
  const pdfData = await pdfParse(dataBuffer, {
    // Custom render to capture page breaks
    pagerender: renderPage
  });

  const text = pdfData.text;
  const pageCount = pdfData.numpages;

  // Try to extract page images for figure detection
  const images = await extractPageImages(filePath, jobId, pageCount);

  return { text, pageCount, images };
}

// Custom page renderer that inserts page markers
function renderPage(pageData) {
  const renderOptions = {
    normalizeWhitespace: false,
    disableCombineTextItems: false
  };
  return pageData.getTextContent(renderOptions).then((textContent) => {
    let lastY = null;
    let text = '';
    for (const item of textContent.items) {
      if (lastY === null || Math.abs(lastY - item.transform[5]) > 5) {
        text += '\n';
      }
      text += item.str;
      lastY = item.transform[5];
    }
    return `\n[PAGE ${pageData.pageNumber}]\n${text}`;
  });
}

/**
 * Extracts page images using pdf2pic.
 * Falls back gracefully if ImageMagick/GraphicsMagick is not available.
 */
async function extractPageImages(filePath, jobId, pageCount) {
  const images = [];
  const outputDir = path.join(__dirname, '../uploads', `${jobId}_images`);

  try {
    const { fromPath } = require('pdf2pic');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const convert = fromPath(filePath, {
      density: 150,
      saveFilename: 'page',
      savePath: outputDir,
      format: 'png',
      width: 1200,
      height: 1600
    });

    // Convert up to 20 pages to keep things fast
    const maxPages = Math.min(pageCount, 20);
    for (let i = 1; i <= maxPages; i++) {
      try {
        const result = await convert(i, { responseType: 'image' });
        if (result && result.path && fs.existsSync(result.path)) {
          // Read image as base64 for sending to Claude
          const imageData = fs.readFileSync(result.path);
          const base64 = imageData.toString('base64');
          images.push({
            page: i,
            path: result.path,
            base64,
            relativePath: `/uploads/${jobId}_images/page.${i}.png`
          });
        }
      } catch (pageErr) {
        // Skip pages that fail — not all PDFs render cleanly
        console.warn(`Could not convert page ${i} to image:`, pageErr.message);
      }
    }
  } catch (err) {
    console.warn('pdf2pic not available or conversion failed:', err.message);
    console.warn('Proceeding with text-only extraction.');
  }

  return images;
}

module.exports = { extractPdfContent };
