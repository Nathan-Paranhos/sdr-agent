# Conhecimento Deploy & CI/CD (Aithos Tech)

## Práticas de Integração Contínua
- **GitHub Actions**: Automatiza testes (`npm test`) e compilação (`npm run build`) a cada pull request.
- **Docker**: Arquivos Dockerfile multi-stage para gerar imagens enxutas de produção (exemplo: Node.js alpine).
- **Prisma & SQLite**: Banco local SQLite é recomendado para testes rápidos e desenvolvimento local. Em produção, use RDS PostgreSQL ou similar. Ao aplicar alterações no SQLite, rode `npx prisma db push` ou execute migrações.
