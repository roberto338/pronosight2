// ══════════════════════════════════════════════
// nexus/lib/ai.js — AI helpers for Nexus
// Supports Claude (Anthropic) and Gemini (Google)
// ══════════════════════════════════════════════

/**
 * Call Claude via Anthropic API (direct fetch, no SDK)
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Object} options
 * @returns {Promise<string>}
 */
export async function callClaude(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurée');

  const model     = options.model     || 'claude-3-5-haiku-20241022';
  const maxTokens = options.maxTokens || 4096;

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Anthropic HTTP ${resp.status}: ${err.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

/**
 * Call Gemini with optional Google Search grounding
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Object} options
 * @returns {Promise<string>}
 */
export async function callGemini(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY non configurée');

  const model     = options.model     || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const useSearch = options.useSearch || false;
  const maxTokens = options.maxTokens || 4096;

  const contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'Compris.' }] });
  }
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const requestBody = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 8192),
      temperature: options.temperature || 0.7,
    },
  };

  if (useSearch) requestBody.tools = [{ googleSearch: {} }];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gemini HTTP ${resp.status}: ${err.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);

  return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

/**
 * Auto-select AI provider.
 * Gemini for research (useSearch), Claude otherwise.
 * Falls back to Gemini if Claude not configured.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Object} options  { provider?: 'claude'|'gemini', useSearch?, maxTokens?, ... }
 * @returns {Promise<string>}
 */
export async function callAI(systemPrompt, userMessage, options = {}) {
  const { provider, useSearch } = options;

  if (provider === 'gemini' || useSearch) {
    return callGemini(systemPrompt, userMessage, options);
  }

  if (provider === 'claude' || process.env.ANTHROPIC_API_KEY) {
    try {
      return await callClaude(systemPrompt, userMessage, options);
    } catch (err) {
      console.warn('[Nexus/AI] Claude failed, fallback Gemini:', err.message);
      return callGemini(systemPrompt, userMessage, options);
    }
  }

  return callGemini(systemPrompt, userMessage, options);
}
