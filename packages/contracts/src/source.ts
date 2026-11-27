export const SOURCE_CODE_PATTERN = 'N[0-9]+';

export function canonicalSourceCode(code: string): string {
  return code.replace(/^A(?=[0-9]+$)/i, 'N');
}

export function legacySourceCode(code: string): string {
  return code.replace(/^N(?=[0-9]+$)/, 'A');
}
