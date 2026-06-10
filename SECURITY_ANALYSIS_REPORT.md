# Relatório de Implementação: Criando a Função `!sec <url>` no SDR-Agent

Este documento contém o **Prompt de Engenharia de Código** otimizado para que você (ou uma IA de codificação) possa implementar a funcionalidade `!sec <url>` diretamente no codebase do seu **sdr-agent**.

---

## Prompt de Geração de Código para Criar a Função `!sec`

Copie e cole o prompt abaixo na sua IA de desenvolvimento preferida para gerar os arquivos e alterações necessárias:

```markdown
Você é um desenvolvedor TypeScript especialista na arquitetura do projeto **SDR-Agent**.
Sua tarefa é criar e implementar uma nova funcionalidade: o comando `!sec <url>`. Esse comando permite que o bot receba uma URL de um site externo no WhatsApp, execute uma varredura de segurança automatizada simulada/controlada por terminal, envie os outputs brutos para um LLM (AppSec-SecAgent) e retorne o relatório estruturado em formato legível de volta para o usuário do WhatsApp.

Siga rigorosamente as instruções de arquitetura e arquivos abaixo:

### 1. Novo Módulo: `src/modules/security-auditor`

Crie o arquivo `src/modules/security-auditor/security-auditor.service.ts`. Ele deve conter:
- **Validação de URL (Prevenção de SSRF)**: Uma função que resolve o IP da URL fornecida e valida se não aponta para IPs de loopback (`127.0.0.1`, `localhost`) ou faixas privadas de rede local (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`), lançando erro se for inválida.
- **Orquestrador da Pipeline**: Uma função assíncrona `runRemoteSecurityAudit(targetUrl: string)` que executa os seguintes passos:
  1. Executa ferramentas de terminal via `child_process` (usando comandos mockados ou reais com flags seguras e rate limit de 10 req/s, ex: `nuclei -u <url> -rl 10` ou `katana -u <url> -d 1`).
  2. Coleta os logs brutos ou arquivos de resultado gerados.
  3. Envia o contexto contendo a URL e os logs das ferramentas para o LLM do OpenRouter/Groq usando o prompt do **AppSec-SecAgent**.
  4. O prompt do LLM exige que ele responda estritamente em JSON de acordo com o esquema da especificação (`agent_meta`, `analytical_engine`, `findings`, `remediation`).
  5. Trata a resposta JSON, formata em uma mensagem bonita e amigável em Markdown com emojis e retorna a string final.

### 2. Integração com o Gerenciador de Grupos (`group-manager.service.ts`)

No arquivo `src/modules/group-manager/group-manager.service.ts`:
- No manipulador de mensagens do grupo `handleGroupInboundMessage`:
  - Adicione a verificação para detectar o comando `!sec` seguido de uma URL (ex: `!sec https://exemplo.com`).
  - Se detectado, envie imediatamente uma mensagem de feedback no grupo informando que a auditoria foi iniciada (ex: "🔍 *Iniciando auditoria de segurança para <url>... Isso pode levar alguns segundos.*").
  - Chame a função `runRemoteSecurityAudit(url)` importada do novo módulo.
  - Envie o relatório final retornado pelo serviço de volta para o grupo usando `sendWhatsAppGroupText(groupId, reply)`.
  - Adicione blocos de `try-catch` robustos para que falhas de DNS, IPs inválidos ou erro de ferramenta não derrubem o bot do WhatsApp.

### 3. Integração com o Chat Direto (`conversation.service.ts`)

No arquivo `src/modules/conversation/conversation.service.ts`:
- No manipulador de mensagens privadas `handleInboundMessage`:
  - Adicione a mesma validação para o comando `!sec <url>`.
  - Se um usuário enviar o comando no privado, responda com o status da execução e envie o relatório final no chat privado do lead usando `sendWhatsAppText(lead.phone, reply)`.

### Diretrizes de Código:
- Use TypeScript moderno compatível com a configuração atual do projeto (`tsconfig.json` e ESM).
- Utilize o cliente de LLM já existente no projeto (`src/integrations/groq/llm.client.ts` ou `src/integrations/openrouter/llm.client.ts`).
- Garanta que a execução de comandos de terminal externa (`exec`) neutralize caracteres especiais de shell injection.
- Não remova ou altere nenhuma outra funcionalidade existente no bot.
```

---

## Arquitetura Recomendada da Implementação

Para sua referência, a estrutura ideal do arquivo de serviço do auditor de segurança (`security-auditor.service.ts`) deve seguir este modelo:

```typescript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import { log } from '../../config/logger.js';
import { callOpenRouterChat } from '../../integrations/openrouter/llm.client.js';

const execAsync = promisify(exec);

// Função para validar IPs e prevenir SSRF
async function validateUrlForScan(targetUrl: string): Promise<void> {
  const parsedUrl = new URL(targetUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Apenas protocolos HTTP e HTTPS são suportados.');
  }

  const lookup = await dns.lookup(parsedUrl.hostname);
  const ip = lookup.address;

  // Verifica se o IP é local ou privado
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0';
  const isPrivate = ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.') || ip.startsWith('169.254.');

  if (isLocal || isPrivate) {
    throw new Error('Alvo inválido: Varreduras em redes internas ou locais não são permitidas.');
  }
}

// Execução segura de comandos (Simulação de ferramentas)
async function runToolScan(tool: string, target: string): Promise<string> {
  // Higieniza o input contra Shell Injection
  const sanitizedTarget = target.replace(/[^a-zA-Z0-9.:/-]/g, '');
  
  try {
    if (tool === 'nuclei') {
      // Exemplo de execução real ou simulação
      const { stdout } = await execAsync(`nuclei -u ${sanitizedTarget} -silent -rl 10 -c 2`);
      return stdout || 'Nenhuma vulnerabilidade crítica de template detectada pelo Nuclei.';
    }
    if (tool === 'katana') {
      const { stdout } = await execAsync(`katana -u ${sanitizedTarget} -silent -d 1`);
      return stdout || 'Nenhum endpoint adicional mapeado no crawling.';
    }
    return '';
  } catch (err) {
    log.error({ err, tool }, 'Falha na execução da ferramenta de segurança');
    return `[Erro na ferramenta ${tool}]`;
  }
}

// Orquestrador principal do escaneamento externo
export async function runRemoteSecurityAudit(targetUrl: string): Promise<string> {
  try {
    await validateUrlForScan(targetUrl);
    
    // 1. Executa Recon e Scan
    const katanaOutput = await runToolScan('katana', targetUrl);
    const nucleiOutput = await runToolScan('nuclei', targetUrl);

    // 2. Monta o Prompt para o Agente AppSec
    const systemPrompt = `Você é o AppSec-SecAgent... [resto do prompt AppSec do documento]`;
    const userContent = `URL Alvo: ${targetUrl}\n\nOutput Katana:\n${katanaOutput}\n\nOutput Nuclei:\n${nucleiOutput}`;

    // 3. Consulta o LLM
    const response = await callOpenRouterChat({
      systemPrompt,
      userContent,
      maxTokens: 1000,
      temperature: 0.2
    });

    const parsedJson = JSON.parse(response.text);

    // 4. Formata a resposta em formato legível de relatório para WhatsApp
    const lines = [
      `🛡️ *Relatório de Segurança: ${parsedJson.agent_meta.target_url}*`,
      `*Fase Concluída*: ${parsedJson.agent_meta.current_phase}`,
      `*Tecnologias*: ${parsedJson.analytical_engine.detected_tech_stack.join(', ')}`,
      `\n📊 *Vulnerabilidades Encontradas:*`
    ];

    if (parsedJson.findings.length === 0) {
      lines.push('✅ Nenhuma vulnerabilidade crítica exposta detectada.');
    } else {
      parsedJson.findings.forEach((finding: any) => {
        lines.push(`⚠️ *[${finding.severity}] ${finding.title}* (${finding.vulnerability_id})`);
        lines.push(`_Descrição_: ${finding.description}`);
        lines.push(`_Evidência_: \`${finding.evidence}\``);
        lines.push('');
      });
    }

    lines.push(`\n🛠️ *Diretrizes de Mitigação:*`);
    lines.push(parsedJson.remediation.mitigation_instructions);

    return lines.join('\n');
  } catch (err) {
    return `❌ *Erro ao auditar site:* ${err instanceof Error ? err.message : String(err)}`;
  }
}
```
