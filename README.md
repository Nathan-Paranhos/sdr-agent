# SDR Agent local minimo

Stack atual:

- Groq para LLM
- Prisma + SQLite local em `prisma/sdr-agent.db`
- WhatsApp via QR no terminal com `whatsapp-web.js`
- Sem Redis, sem BullMQ, sem Docker, sem Evolution API e sem conectores externos

## Rodar

1. Configure `GROQ_API_KEY` no `.env`.
   - Opcional: configure `GROQ_API_KEYS=gsk_chave_1,gsk_chave_2` para alternar entre varias chaves.
   - `GROQ_MIN_DELAY_MS` controla o intervalo minimo entre chamadas de IA para evitar limite de tokens por minuto.
   - `GROQ_RETRY_ROUNDS` controla quantas rodadas de tentativa sao feitas usando modelos e chaves configuradas.
2. Inicie o agente:

```powershell
npm run dev
```

3. Escaneie o QR pelo WhatsApp.

O app cria/atualiza o banco automaticamente no startup com `prisma db push`.

## Enviar CSV pelo WhatsApp

Somente o numero configurado em `OPERATOR_PHONE` pode enviar CSV:

```env
OPERATOR_PHONE=+5511xxxxxx
```

Envie um arquivo `.csv` ou cole o CSV em texto no WhatsApp conectado ao bot.

Formato minimo:

```csv
company_name,phone,website,instagram,contact_name,segment
Empresa Teste,+5511999999999,https://empresa.com.br,,Joao,clinica
```

O lead precisa ter `website` ou `instagram`; sem fonte de pesquisa ele entra em quarentena e nao recebe mensagem generica.

## Enviar CSV por HTTP

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/leads" -Method Post -ContentType "text/csv" -InFile ".\leads.csv"
```
