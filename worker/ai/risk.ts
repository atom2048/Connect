import type { TextDataRisk } from './types';

export type RiskFinding = { kind: 'personal' | 'credential' | 'payment' | 'government'; value: string };
export type RiskScan = { risk: TextDataRisk; findings: RiskFinding[] };

const boundedMatches = (text: string, pattern: RegExp, max = 32): string[] => {
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    values.push(match[0]);
    if (values.length >= max) break;
  }
  return values;
};

function luhn(value: string): boolean {
  const digits = value.replace(/[- ]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function scanTextRisk(input: string): RiskScan {
  try {
    const text = input.slice(0, 160_000);
    const findings: RiskFinding[] = [];
    const credentials = [
      ...boundedMatches(text, /\b(?:sk-or-v1-|sk-|AKIA)[A-Za-z0-9_-]{16,}\b/g),
      ...boundedMatches(text, /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*\b/gi),
      ...boundedMatches(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g),
      ...boundedMatches(text, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g),
      ...boundedMatches(text, /\b(?:password|passwd|session_cookie|session token)\s*[:=]\s*[^\s]{8,}/gi),
    ];
    findings.push(...credentials.map((value) => ({ kind: 'credential' as const, value })));
    for (const candidate of boundedMatches(text, /(?:\d[ -]?){13,19}/g)) if (luhn(candidate)) findings.push({ kind: 'payment', value: candidate });
    for (const value of boundedMatches(text, /(?:マイナンバー|個人番号)\s*[:：]?\s*\d{4}\s?\d{4}\s?\d{4}/g)) findings.push({ kind: 'government', value });
    if (findings.some((item) => item.kind !== 'personal')) return { risk: 'BLOCKED', findings };

    // Require a phone-shaped token to be a standalone value and to contain
    // at least ten digits. Without the boundary/length check, the old
    // expression treated the trailing `0260922` inside a date such as
    // `20260922` as a phone number and unnecessarily escalated PUBLIC_AI to
    // the restricted-provider path.
    const phoneNumbers = boundedMatches(text, /(?<![\dA-Za-z])(?:\+?81[- ]?)?0\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4}(?![\dA-Za-z])/g)
      .filter((value) => value.replace(/\D/g, '').length >= 10);
    const personal = [
      ...boundedMatches(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi),
      ...phoneNumbers,
      ...boundedMatches(text, /[-+]?\d{1,2}\.\d{4,}\s*[,，]\s*[-+]?\d{1,3}\.\d{4,}/g),
    ];
    findings.push(...personal.map((value) => ({ kind: 'personal' as const, value })));
    return { risk: personal.length ? 'PERSONAL_DATA' : 'CLEAR', findings };
  } catch {
    return { risk: 'SCAN_FAILED', findings: [] };
  }
}

export function validateOutputRisk(output: string, authorizedInput: string): { allowed: boolean; cacheable: boolean; scan: RiskScan } {
  const scan = scanTextRisk(output);
  if (scan.risk === 'BLOCKED' || scan.risk === 'SCAN_FAILED') return { allowed: false, cacheable: false, scan };
  if (scan.risk === 'CLEAR') return { allowed: true, cacheable: true, scan };
  const hallucinated = scan.findings.some((finding) => !authorizedInput.includes(finding.value));
  return { allowed: !hallucinated, cacheable: false, scan };
}
