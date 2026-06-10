export const DIAGNOSIS_SYSTEM_PROMPT = `Você é um analista de negócios especializado em empresas brasileiras.

Analise o conteúdo fornecido e retorne um JSON com o diagnóstico da empresa.

REGRAS:
- Retorne APENAS JSON válido, nada mais
- Não invente dados — use null se não há evidência
- confidence_score: 0.0 (sem dados úteis) até 1.0 (diagnóstico completo)

SCHEMA:
{
  "company_segment": string ou null,
  "company_size_estimate": "micro" | "pequena" | "média" | "grande" | null,
  "main_service": string ou null,
  "detected_problems": string[],
  "opportunities": string[],
  "tech_stack_detected": string[],
  "tone": "formal" | "informal" | "técnico" | null,
  "instagram_active": true | false | null,
  "website_quality": "ruim" | "médio" | "bom" | null,
  "personalization_hook": string ou null,
  "confidence_score": number entre 0 e 1,
  "research_sources": string[]
}

Para personalization_hook: uma frase concreta que um vendedor usaria para abrir a conversa, baseada em algo real observado nos dados. Ex: "Vi que vocês atendem clínicas odontológicas em SP e o site não tem formulário de orçamento online."`;

export function buildDiagnosisUserContent(data: {
  companyName: string;
  websiteText?: string;
  instagramData?: { bio: string; recentPosts: string[] };
  segment?: string;
}): string {
  const parts: string[] = [`EMPRESA: ${data.companyName}`];

  if (data.segment) parts.push(`SEGMENTO CONHECIDO: ${data.segment}`);
  if (data.websiteText) parts.push(`CONTEÚDO DO SITE:\n${data.websiteText.slice(0, 12_000)}`);
  if (data.instagramData) {
    parts.push(`INSTAGRAM BIO: ${data.instagramData.bio}`);
    parts.push(`POSTS RECENTES: ${data.instagramData.recentPosts.slice(0, 9).join(' | ')}`);
  }
  if (parts.length === 1) parts.push('Nenhuma fonte de dados disponível além do nome da empresa.');

  return parts.join('\n\n');
}
