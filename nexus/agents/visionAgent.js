// ══════════════════════════════════════════════
// nexus/agents/visionAgent.js
// Image analysis via Claude Vision API
// ══════════════════════════════════════════════

const VISION_SYSTEM = `Tu es un agent Vision expert. Tu analyses les images et documents PDF avec précision et retournes des insights structurés, actionnables et détaillés.
Identifie: éléments visuels clés, texte présent, métriques visibles, points d'amélioration, insights stratégiques.
Pour les PDFs: résume le contenu, extrais les points clés, signale les informations importantes.
Sois concis et précis. Structure ta réponse avec des sections claires.`;

/**
 * @param {Object} ctx
 * @param {string} ctx.input          Instruction / question about the image
 * @param {Object} ctx.meta           { imageUrl?, imageBase64?, imageMediaType?, instruction? }
 * @returns {Promise<{output: string, meta: Object}>}
 */
export async function runVision({ input, meta = {} }) {
  const { imageUrl, imageBase64, imageMediaType = 'image/jpeg' } = meta;
  const instruction = meta.instruction || input || 'Analyse cette image en détail.';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY requis pour Vision');

  if (!imageUrl && !imageBase64) {
    throw new Error('Vision: imageUrl ou imageBase64 requis dans meta');
  }

  console.log(`[VisionAgent] Analysing image: ${instruction.slice(0, 60)}`);

  // Build image / document content block
  // PDFs require type:'document' in the Claude API; images use type:'image'
  let imageBlock;
  if (imageBase64) {
    if (imageMediaType === 'application/pdf') {
      imageBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } };
    } else {
      imageBlock = { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } };
    }
  } else {
    imageBlock = { type: 'image', source: { type: 'url', url: imageUrl } };
  }

  const model = process.env.VISION_MODEL || 'claude-3-5-sonnet-20241022';

  const body = {
    model,
    max_tokens: meta.maxTokens || 4096,
    system:     VISION_SYSTEM,
    messages: [{
      role:    'user',
      content: [
        imageBlock,
        { type: 'text', text: instruction },
      ],
    }],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Vision API ${resp.status}: ${err.error?.message || resp.statusText}`);
  }

  const data   = await resp.json();
  const output = data.content?.[0]?.text || '';

  return {
    output,
    meta: {
      agent:       'vision',
      model,
      instruction: instruction.slice(0, 100),
      source:      imageUrl ? 'url' : 'base64',
    },
  };
}
