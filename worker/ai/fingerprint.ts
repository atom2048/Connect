import { ANSWER_SEMANTICS_VERSION, CONTEXT_ALGORITHM_VERSION, CONTEXT_SERIALIZER_VERSION, DATA_RISK_SCANNER_VERSION, MEDIA_TRANSFORM_VERSION, MEDIA_USAGE_POLICY_VERSION, MODEL_OUTPUT_ADAPTER_VERSION, OUTPUT_SCHEMA_VERSION } from './config';
import { systemPromptDigest } from './prompt';
import type { MediaManifestItem, MediaTarget, MediaUsageMode, TextDataRisk, VersionedContextManifest } from './types';

export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function semanticFingerprint(input: {
  question: string;
  manifest: VersionedContextManifest;
  mode: MediaUsageMode;
  target: MediaTarget;
  selectedMedia: MediaManifestItem[];
  risk: TextDataRisk;
  locale: string;
}): Promise<string> {
  const vision = input.mode !== 'TEXT_ONLY';
  return sha256(JSON.stringify({
    question: input.question,
    mode: input.mode,
    target: input.target,
    sources: input.manifest.sources.map((source) => ({
      ref: source.ref, actualId: source.actualId, relation: source.relation, order: source.order,
      contentVersion: source.contentVersion, accessVersion: source.accessVersion,
      structureVersion: source.structureVersion, authorPreferenceVersion: source.authorPreferenceVersion, postConsentVersion: source.postConsentVersion,
      acceptedPolicyVersion: source.acceptedPolicyVersion,
      ...(vision ? { mediaVersion: source.mediaVersion } : {}),
    })),
    media: vision ? input.selectedMedia.map(({ ref, belongsTo, sha256: digest, mediaVersion }, order) => ({ ref, belongsTo, digest, mediaVersion, order })) : undefined,
    privacyClass: input.manifest.privacyClass,
    authorConsentVector: input.manifest.authorConsentVector,
    risk: input.risk,
    locale: input.locale,
    versions: {
      systemPromptDigest: await systemPromptDigest(), answer: ANSWER_SEMANTICS_VERSION, context: CONTEXT_ALGORITHM_VERSION,
      serializer: CONTEXT_SERIALIZER_VERSION, output: OUTPUT_SCHEMA_VERSION, adapter: MODEL_OUTPUT_ADAPTER_VERSION,
      scanner: DATA_RISK_SCANNER_VERSION, mediaUsage: MEDIA_USAGE_POLICY_VERSION, transform: vision ? MEDIA_TRANSFORM_VERSION : undefined,
    },
  }));
}
