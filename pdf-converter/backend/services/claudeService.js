const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const MODEL = 'claude-sonnet-4-6';

/**
 * Creates an Anthropic client using the best available authentication:
 *  1. ANTHROPIC_API_KEY env var (standard API key)
 *  2. CLAUDE_SESSION_INGRESS_TOKEN_FILE (Claude Code on the web session token, Bearer auth)
 *
 * Re-reads the session token on every call so expiry/rotation is handled transparently.
 */
function createClient() {
  if (process.env.ANTHROPIC_API_KEY) {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  const tokenFile = process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE;
  if (tokenFile) {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (token) {
        return new Anthropic({ authToken: token });
      }
    } catch (e) {
      console.warn('Could not read session token file:', e.message);
    }
  }

  // Last resort — SDK will throw a clear error on the first call
  return new Anthropic({ apiKey: 'missing' });
}

/**
 * Analyzes extracted PDF text (and optional page images) using Claude
 * to produce a structured document outline with summaries and figure detection.
 */
async function analyzeStructure(text, images, jobId) {
  const client = createClient();

  // Truncate very long documents to fit context window
  const maxChars = 80000;
  const truncatedText = text.length > maxChars
    ? text.slice(0, maxChars) + '\n\n[... document truncated for analysis ...]'
    : text;

  const systemPrompt = buildSystemPrompt();
  const userContent = buildUserContent(truncatedText, images);

  console.log(`[${jobId}] Sending document to Claude (${MODEL}) for analysis...`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  });

  const rawContent = response.content[0].text;

  console.log(`[${jobId}] Claude response received, parsing JSON...`);

  const structure = parseJsonFromResponse(rawContent);
  return normalizeStructure(structure);
}

function buildSystemPrompt() {
  return `You are an expert document analyst. Your job is to analyze PDF report content and produce a structured JSON outline of the document.

RULES:
1. Identify the document title, chapters, and sub-chapters based on headings, numbering patterns, and content flow.
2. For each chapter and sub-chapter, write a 2-4 sentence summary. Write in the author's own voice and tone — do NOT use meta-commentary like "This section discusses...", "The chapter covers...", or "The author explains...". Write the substance directly as if you are the author: e.g. instead of "The Executive Summary argues that housing policy has fundamentally failed" write "Housing policy has fundamentally failed to...". Include the main arguments and key points.
3. Detect figures, charts, tables, and images referenced in the text.
4. Return ONLY valid JSON — no markdown fences, no explanation text, just the raw JSON object.

JSON SCHEMA (follow exactly):
{
  "title": "string — document title",
  "chapters": [
    {
      "id": "ch1",
      "title": "string",
      "pages": [startPage, endPage],
      "summary": "string — 2-4 sentence summary",
      "subchapters": [
        {
          "id": "ch1-1",
          "title": "string",
          "pages": [startPage, endPage],
          "summary": "string",
          "content": "string — relevant text excerpt (max 1000 chars)",
          "figures": [
            {
              "id": "fig1",
              "page": pageNumber,
              "type": "chart|table|image|unknown",
              "caption": "string — detected or inferred caption",
              "interpretation": "string — what this figure shows",
              "confidence": 0.85
            }
          ]
        }
      ]
    }
  ]
}

If the document has no clear sub-chapter structure, create sub-chapters by logical content sections.
Assign reasonable page ranges based on [PAGE N] markers in the text.
For figures: scan for "Figure", "Fig.", "Table", "Chart", "Graph" references and include them.`;
}

function buildUserContent(text, images) {
  const content = [];

  content.push({
    type: 'text',
    text: `Please analyze this PDF document content and return the structured JSON outline:\n\n${text}`
  });

  // Add up to 5 page images for visual analysis (to detect charts/figures)
  if (images && images.length > 0) {
    const sampleImages = images.slice(0, 5);
    content.push({
      type: 'text',
      text: `\nI'm also providing ${sampleImages.length} page image(s) to help detect visual elements like charts, tables, and figures:`
    });

    for (const img of sampleImages) {
      if (img.base64) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: img.base64
          }
        });
        content.push({
          type: 'text',
          text: `(Above image is page ${img.page})`
        });
      }
    }
  }

  return content;
}

function parseJsonFromResponse(raw) {
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch {}

  // Try extracting from markdown code block
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // Try finding the outermost JSON object
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  throw new Error('Could not parse JSON structure from Claude response');
}

function normalizeStructure(structure) {
  if (!structure.title) structure.title = 'Untitled Document';
  if (!Array.isArray(structure.chapters)) structure.chapters = [];

  structure.chapters = structure.chapters.map((ch, ci) => {
    const chapterId = ch.id || `ch${ci + 1}`;
    return {
      id: chapterId,
      title: ch.title || `Chapter ${ci + 1}`,
      pages: Array.isArray(ch.pages) ? ch.pages : [1, 1],
      summary: ch.summary || '',
      subchapters: Array.isArray(ch.subchapters)
        ? ch.subchapters.map((sub, si) => normalizeSub(sub, chapterId, si))
        : []
    };
  });

  return structure;
}

function normalizeSub(sub, chapterId, si) {
  const subId = sub.id || `${chapterId}-${si + 1}`;
  return {
    id: subId,
    title: sub.title || `Section ${si + 1}`,
    pages: Array.isArray(sub.pages) ? sub.pages : [1, 1],
    summary: sub.summary || '',
    content: sub.content || '',
    figures: Array.isArray(sub.figures)
      ? sub.figures.map((fig, fi) => normalizeFigure(fig, subId, fi))
      : []
  };
}

function normalizeFigure(fig, subId, fi) {
  return {
    id: fig.id || `${subId}-fig${fi + 1}`,
    page: fig.page || 1,
    type: ['chart', 'table', 'image', 'unknown'].includes(fig.type) ? fig.type : 'unknown',
    caption: fig.caption || 'Figure',
    interpretation: fig.interpretation || 'No interpretation available.',
    confidence: typeof fig.confidence === 'number'
      ? Math.max(0, Math.min(1, fig.confidence))
      : 0.5
  };
}

module.exports = { analyzeStructure };
