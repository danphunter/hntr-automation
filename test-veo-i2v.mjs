// Standalone test: Veo i2v WITHOUT recaptchaContext
// Usage:
//   node test-veo-i2v.mjs <bearer_token> [mediaId]
//   node test-veo-i2v.mjs ya29.xxx test123
//
// Or set env var: VEO_TOKEN=ya29.xxx node test-veo-i2v.mjs

import { randomUUID } from 'crypto';

const token = process.argv[2] || process.env.VEO_TOKEN;
const mediaId = process.argv[3] || 'test123';
const projectId = 'b998a407-4f9a-4b0c-9bc9-f2fae2a5a077';

if (!token || !token.startsWith('ya29')) {
  console.error('Usage: node test-veo-i2v.mjs <ya29.xxx token> [mediaId]');
  process.exit(1);
}

const batchId = randomUUID();

const body = {
  mediaGenerationContext: { batchId },
  clientContext: {
    projectId,
    tool: 'PINHOLE',
    userPaygateTier: 'PAYGATE_TIER_TWO',
  },
  requests: [{
    aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
    metadata: {},
    seed: Math.floor(Math.random() * 1000000),
    startImage: {
      mediaId,
      cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 },
    },
    textInput: { structuredPrompt: { parts: [{ text: 'cinematic motion' }] } },
    videoModelKey: 'veo_3_1_i2v_s_fast_ultra',
  }],
  useV2ModelConfig: true,
};

console.log('--- REQUEST ---');
console.log('POST https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage');
console.log('Token:', token.slice(0, 20) + '...');
console.log('Body:', JSON.stringify(body, null, 2));
console.log('');

const res = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
  body: JSON.stringify(body),
});

const text = await res.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = text; }

console.log('--- RESPONSE ---');
console.log('HTTP Status:', res.status);
console.log('Body:', JSON.stringify(parsed, null, 2));
