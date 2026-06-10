export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
