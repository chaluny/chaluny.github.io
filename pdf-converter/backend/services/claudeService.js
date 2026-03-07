/**
 * claudeService.js — optional AI summary generation using Claude.
 *
 * Marker handles the PDF-to-structure conversion without any LLM.
 * This service is only used when the user opts in to AI summaries,
 * adding a 2-4 sentence author-voice summary to each section.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const MODEL = 'claude-sonnet-4-6';

/**
 * Creates an Anthropic client using the best available auth:
 *  1. ANTHROPIC_API_KEY env var
 *  2. CLAUDE_SESSION_INGRESS_TOKEN_FILE (Claude Code on the web session token)
 *
 * Re-reads the session token on every call so rotation is handled transparently.
 */
function createClient() {
  if (process.env.ANTHROPIC_API_KEY) {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  const tokenFile = process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE;
  if (tokenFile) {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (token) return new Anthropic({ authToken: token });
    } catch (e) {
      console.warn('Could not read session token file:', e.message);
    }
  }

  return new Anthropic({ apiKey: 'missing' });
}

/**
 * Add AI-generated summaries to each subchapter in the structure.
 * Mutates structure in place (sets sub.summary and ch.summary).
 *
 * @param {object} structure   - { title, chapters } from markerService
 * @param {Function} [onProgress] - called with (percent, message)
 */
async function generateSectionSummaries(structure, onProgress) {
  const client = createClient();

  // Collect all subchapters that have content
  const subsWithContent = [];
  for (const ch of structure.chapters || []) {
    for (const sub of ch.subchapters || []) {
      const text = htmlToPlainText(sub.htmlContent || sub.content || '');
      if (text.length > 50) subsWithContent.push({ ch, sub, text });
    }
  }

  if (subsWithContent.length === 0) return;

  const total = subsWithContent.length;
  let done = 0;
  const CONCURRENCY = 5;

  async function summariseOne({ sub, text }) {
    const snippet = text.slice(0, 3000);
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 250,
        messages: [{
          role: 'user',
          content:
            `Summarise the section below in 2–4 sentences. ` +
            `Write in the author's own voice and tone — do NOT use meta-commentary ` +
            `like "This section discusses..." or "The author argues...". ` +
            `Write directly as if you are the author summarising their own work.\n\n` +
            `Section title: ${sub.title || 'Untitled'}\n\n${snippet}`
        }]
      });
      sub.summary = response.content[0].text.trim();
    } catch (err) {
      console.warn(`Summary failed for "${sub.title}":`, err.message);
      sub.summary = null;
    }
    done++;
    if (onProgress) {
      const pct = 80 + Math.round((done / total) * 15);
      onProgress(pct, `Generating AI summaries… (${done}/${total})`);
    }
  }

  // Run in parallel batches of CONCURRENCY
  for (let i = 0; i < subsWithContent.length; i += CONCURRENCY) {
    const batch = subsWithContent.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(summariseOne));
  }

  // Roll up chapter-level summaries from the first subchapter with a summary
  for (const ch of structure.chapters || []) {
    const firstSub = (ch.subchapters || []).find(s => s.summary);
    ch.summary = firstSub ? firstSub.summary : null;
  }
}

/** Strip HTML tags and collapse whitespace to plain text. */
function htmlToPlainText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { generateSectionSummaries };
