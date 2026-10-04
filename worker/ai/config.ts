import type { MaterializedImage, MediaUsageMode, MediaTarget } from './types';

export const CURRENT_AI_POLICY_VERSION = 'connect-ai-policy-v1';
export const ANSWER_SEMANTICS_VERSION = 'v1';
export const CONTEXT_ALGORITHM_VERSION = 'v1';
export const CONTEXT_SERIALIZER_VERSION = 'v1';
export const OUTPUT_SCHEMA_VERSION = 'v1';
export const MODEL_OUTPUT_ADAPTER_VERSION = 'v1';
export const DATA_RISK_SCANNER_VERSION = 'v1';
export const MEDIA_USAGE_POLICY_VERSION = 'v1';
export const MEDIA_TRANSFORM_VERSION = 'v1';

export const AI_LIMITS = {
  bodyBytes: 8_192,
  questionCodePoints: 2_000,
  questionBytes: 6_000,
  contextTargetTokens: 12_000,
  contextHardTokens: 24_000,
  // Profile context is assembled from bounded recent rows, but a token
  // estimate alone is not enough for CJK text and JSON overhead. Keep an
  // explicit character ceiling as a second guardrail.
  profileContextTargetTokens: 8_000,
  profileContextMaxChars: 32_000,
  // Profile text answers are intentionally concise. Profile vision gets the
  // model's normal bounded completion budget; forcing the text cap truncated
  // valid multimodal JSON before it could be parsed.
  profileAnswerMaxTokens: 1_200,
  profileVisionAnswerMaxTokens: 3_200,
  maxImages: 4,
  originalImageBytes: 5_000_000,
  originalTotalBytes: 20_000_000,
  transformedImageBytes: 1_500_000,
  transformedTotalBytes: 4_000_000,
  upstreamBodyBytes: 8_000_000,
  answerChars: 16_000,
  globalDeadlineMs: 52_000,
  cleanupReserveMs: 2_000,
} as const;

const VISUAL_REQUIRED = /(画像|写真|スクショ|スクリーンショット|図|グラフ|写って|見える|読める|何が書いて|image|photo|screenshot|chart|graph)/iu;
const ALL_MEDIA = /(引用画像|すべての画像|全部の画像|all images|quoted image)/iu;
const WHOLE_POST = /(投稿全体|全体を説明|全体の要点|内容を説明|what is this post|explain this post)/iu;

export function resolveMediaUsage(question: string, requested: 'auto' | 'include' | 'exclude'): { mode: MediaUsageMode; target: MediaTarget } {
  if (requested === 'exclude') return { mode: 'TEXT_ONLY', target: 'CURRENT_POST' };
  if (requested === 'include') return { mode: 'VISION_REQUIRED', target: ALL_MEDIA.test(question) ? 'ALL_RELEVANT' : 'CURRENT_POST' };
  if (VISUAL_REQUIRED.test(question)) return { mode: 'VISION_REQUIRED', target: ALL_MEDIA.test(question) ? 'ALL_RELEVANT' : 'CURRENT_POST' };
  if (WHOLE_POST.test(question)) return { mode: 'VISION_OPTIONAL', target: 'ALL_RELEVANT' };
  return { mode: 'TEXT_ONLY', target: 'CURRENT_POST' };
}

/**
 * The model names shown in the UI are deliberately kept separate from the
 * OpenRouter slugs.  A slug is only usable after the Worker has an unexpired
 * endpoint snapshot for the exact free endpoint and provider.
 */
export type ModelKey =
  | 'minimaxM3'
  | 'nemotronUltra'
  | 'hy3'
  | 'minimaxM27'
  | 'lagunaS21'
  | 'inkling'
  // Privacy-only compatibility route.  This is a current free ZDR
  // multimodal endpoint and is never accepted without a fresh smoke-tested
  // snapshot from the ZDR catalog.
  | 'lingVl'
  | 'gemma31'
  | 'gemma26'
  // Kept as a last-resort compatibility route while the new catalog is
  // being revalidated. These are still :free models and remain policy gated.
  | 'glm52'
  | 'dots';

export type AiRoute = 'text' | 'coding' | 'vision';

export const MODEL_CHAINS: Record<AiRoute, readonly ModelKey[]> = {
  // Text / General
  text: ['minimaxM3', 'nemotronUltra', 'hy3'],
  // Coding / Agent (available to future agent callers; the current Ask AI
  // dialog selects text or vision based on its media mode).
  coding: ['nemotronUltra', 'minimaxM3', 'minimaxM27', 'lagunaS21'],
  // Vision
  vision: ['minimaxM3', 'inkling', 'gemma31', 'gemma26'],
};

export const LEGACY_MODEL_CHAINS: Record<'text' | 'vision', readonly ModelKey[]> = {
  text: ['glm52', 'dots', 'gemma31', 'gemma26', 'lingVl'],
  vision: ['dots', 'gemma31', 'gemma26', 'glm52', 'lingVl'],
};

export const MODEL_CONFIG: Record<ModelKey, {
  id: string;
  outputMode: 'json_schema' | 'json_object' | 'prompt_json';
  maxCompletionTokens: number;
  timeoutMs: number;
  supportsVision?: boolean;
}> = {
  minimaxM3: { id: 'minimax/minimax-m3:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 30_000, supportsVision: true },
  nemotronUltra: { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 45_000 },
  hy3: { id: 'tencent/hy3:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 30_000 },
  minimaxM27: { id: 'minimax/minimax-m2.7:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 30_000 },
  lagunaS21: { id: 'poolside/laguna-s-2.1:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 30_000 },
  inkling: { id: 'thinkingmachines/inkling:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 30_000, supportsVision: true },
  lingVl: { id: 'inclusionai/ling-3.0-flash-vl:free', outputMode: 'prompt_json', maxCompletionTokens: 1600, timeoutMs: 30_000, supportsVision: true },
  gemma31: { id: 'google/gemma-4-31b-it:free', outputMode: 'json_object', maxCompletionTokens: 1600, timeoutMs: 20_000, supportsVision: true },
  gemma26: { id: 'google/gemma-4-26b-a4b-it:free', outputMode: 'json_object', maxCompletionTokens: 1600, timeoutMs: 15_000, supportsVision: true },
  glm52: { id: 'z-ai/glm-5.2:free', outputMode: 'json_schema', maxCompletionTokens: 1600, timeoutMs: 20_000 },
  // Vision responses from this free endpoint can deliver headers well before
  // the streamed body is complete. Keep the bounded request below the global
  // deadline while allowing the body read to finish.
  // Dots can spend a bounded amount of its completion budget on visual
  // reasoning before emitting the JSON answer. 1600 tokens was enough for a
  // single post but was truncated for a profile with several images.
  dots: { id: 'dots-studio/dots-3-note-preview:free', outputMode: 'json_schema', maxCompletionTokens: 3200, timeoutMs: 40_000, supportsVision: true },
};

/**
 * OpenRouter's endpoint API may omit `data_policy` for a currently listed
 * endpoint.  An omitted value is otherwise unsafe to interpret as a policy
 * approval.  These are the only exact model/provider/endpoint combinations
 * whose no-training policy was separately reviewed from OpenRouter's provider
 * directory.  The match is intentionally exact so a provider or endpoint
 * change remains fail-closed until it is reviewed again.
 */
export const REVIEWED_NO_TRAINING_ENDPOINTS = [
  { model: MODEL_CONFIG.dots.id, provider: 'AtlasCloud', tag: 'atlas-cloud/fp8', source: 'openrouter-provider-directory' },
  { model: MODEL_CONFIG.gemma31.id, provider: 'Google AI Studio', tag: 'google-ai-studio', source: 'openrouter-provider-directory' },
  { model: MODEL_CONFIG.gemma26.id, provider: 'Google AI Studio', tag: 'google-ai-studio', source: 'openrouter-provider-directory' },
] as const;

export function reviewedNoTrainingEndpoint(model: string, provider: string, tag: string): (typeof REVIEWED_NO_TRAINING_ENDPOINTS)[number] | null {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedTag = tag.trim();
  return REVIEWED_NO_TRAINING_ENDPOINTS.find((candidate) => candidate.model === model
    && candidate.provider.toLowerCase() === normalizedProvider
    && candidate.tag === normalizedTag) || null;
}

/**
 * Keep a required visual request visual all the way through the finite
 * fallback chain. Optional visual requests may safely degrade to text when a
 * text-only endpoint is the only approved fallback, but a required visual
 * request must skip that endpoint without spending an upstream attempt.
 */
export function imagesForModel(key: ModelKey, mode: MediaUsageMode, images: MaterializedImage[]): MaterializedImage[] | null {
  if (mode === 'VISION_REQUIRED' && images.length && !MODEL_CONFIG[key].supportsVision) return null;
  return MODEL_CONFIG[key].supportsVision ? images : [];
}

export const MODEL_ANSWER_JSON_SCHEMA = {
  name: 'connect_ask_ai_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'citedRefs', 'insufficientContext'],
    properties: {
      answer: { type: 'string', maxLength: AI_LIMITS.answerChars },
      citedRefs: { type: 'array', maxItems: 32, items: { type: 'string' } },
      usedMediaRefs: { type: 'array', maxItems: 4, items: { type: 'string' } },
      insufficientContext: { type: 'boolean' },
    },
  },
} as const;
