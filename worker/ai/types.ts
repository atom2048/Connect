export type PrivacyClass = 'PUBLIC_AI' | 'LIMITED_AI' | 'PRIVATE_AI';
export type TextDataRisk = 'CLEAR' | 'PERSONAL_DATA' | 'BLOCKED' | 'SCAN_FAILED';
export type MediaUsageMode = 'TEXT_ONLY' | 'VISION_OPTIONAL' | 'VISION_REQUIRED';
export type MediaTarget = 'CURRENT_POST' | 'ALL_RELEVANT';
export type ConsentLevel = 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT';
export type ContextSourceType = 'profile' | 'post' | 'comment';

export type AuthorAiPreferences = {
  acceptedPolicyVersion: string | null;
  preferenceVersion: number;
  textAnalysis: ConsentLevel;
  mediaAnalysis: ConsentLevel;
};

export type ConsentDecision = { allowText: boolean; allowMedia: boolean };

export type ContextSourceVersion = {
  ref: string;
  actualId: string;
  type: ContextSourceType;
  relation: 'current' | 'reply_parent' | 'quote' | 'thread' | 'reply';
  authorId: string;
  visibility: string;
  contentVersion: number;
  accessVersion: number;
  mediaVersion: number;
  structureVersion: number;
  authorPreferenceVersion: number;
  postConsentVersion: number;
  acceptedPolicyVersion: string | null;
};

export type ContextSource = ContextSourceVersion & {
  text: string;
  order: number;
  allowText: boolean;
  allowMedia: boolean;
};

export type MediaManifestItem = {
  ref: string;
  belongsTo: string;
  position: number;
  objectKey: string;
  sha256: string | null;
  mimeType: string;
  bytes: number | null;
  animated: boolean;
  sourceRelation: ContextSource['relation'];
  sourceVisibility: string;
  mediaVersion: number;
  allowedByConsent: boolean;
};

export type InternalMediaCoverage = {
  imagesPresent: number;
  imagesEligibleByConsent: number;
  imagesSupported: number;
  imagesSelected: number;
  imagesAnalyzed: number;
  animatedImagesTruncated: number;
  videosPresent: number;
};

export type VersionedContextManifest = {
  subjectType?: 'post' | 'profile';
  subjectId?: string;
  currentPostId: string;
  currentAuthorId: string;
  sources: ContextSource[];
  media: MediaManifestItem[];
  privacyClass: PrivacyClass;
  contextTruncated: boolean;
  authorConsentVector: string;
};

export type ModelAnswer = {
  answer: string;
  citedRefs: string[];
  usedMediaRefs?: string[];
  insufficientContext: boolean;
};

export type AskAiResponse = {
  answer: string;
  insufficientContext: boolean;
  insufficientReason?: 'MEDIA_NOT_AVAILABLE' | 'MEDIA_ANALYSIS_NOT_ALLOWED' | 'UNSUPPORTED_MEDIA';
  citations: Array<{
    ref: string;
    type: ContextSourceType;
    id: string;
    relation: 'current' | 'reply_parent' | 'quote' | 'thread' | 'reply';
  }>;
  coverage: {
    modalityRequested: 'text' | 'vision';
    modalityUsed: 'text' | 'vision';
    imagesTotal: number;
    imagesAnalyzed: number;
    animatedImagesTruncated: number;
    videosTotal: number;
    videosAnalyzed: 0;
    unsupportedImages: number;
    contextTruncated: boolean;
    answerTruncated: boolean;
  };
  degraded: boolean;
  degradedReason?: 'vision_unavailable' | 'capacity' | 'unsupported_media';
  requestId: string;
  feedbackToken?: string;
};

export type HardStopReason = 'BILLING_INVARIANT' | 'PROVIDER_PRIVACY_INVARIANT' | 'MANUAL' | 'UPSTREAM_OUTAGE' | 'RISK_SCANNER_FAILURE';
export type UpstreamPermitState = 'RESERVED' | 'DISPATCHED' | 'FINISHED' | 'RELEASED' | 'EXPIRED';

export type ApprovedEndpointSnapshot = {
  requestedModel: string;
  canonicalModel: string;
  providerModel: string;
  providerBaseSlug: string;
  providerEndpointSlug: string;
  trainingAllowed: false;
  retention: { type: 'fixed'; days: number } | { type: 'retained' } | { type: 'zdr' } | { type: 'unknown' };
  pricing: Record<string, string | null>;
  nonApplicablePricingDimensions?: string[];
  supportedParameters: string[];
  verifiedAt: string;
  expiresAt: string;
  generationPolicyVersion: string;
};

export type MaterializedImage = {
  ref: string;
  belongsTo: string;
  position: number;
  dataUrl: string;
  binaryBytes: number;
  animatedTruncated: boolean;
};

export type GenerationRequest = {
  viewerId: string;
  deliveryRequestId: string;
  generationReservationId: string;
  question: string;
  locale: string;
  semanticFingerprint: string;
  manifest: VersionedContextManifest;
  mediaUsageMode: MediaUsageMode;
  mediaTarget: MediaTarget;
  inputRisk: TextDataRisk;
  selectedMedia: MediaManifestItem[];
  deadlineAt: number;
};

export type GenerationResult = {
  response: Omit<AskAiResponse, 'requestId' | 'feedbackToken'>;
  generationId: string;
  generationPolicyVersion: string;
  cacheable: boolean;
};
