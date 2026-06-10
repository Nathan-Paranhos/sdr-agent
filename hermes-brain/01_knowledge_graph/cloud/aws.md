# Conhecimento Cloud - AWS (Aithos Tech)

## Padrões de Deploy
- **AWS ECS (Elastic Container Service)**: Recomendado para rodar APIs conteinerizadas via Docker. Utiliza Fargate para execução serverless sem gerenciar EC2.
- **Segurança IAM**: Sempre drop Capabilities não utilizadas. Nunca use chaves de acesso root nos containers. Use IAM Roles anexadas ao Task Definition.
- **Banco de Dados**: RDS PostgreSQL/MySQL com conexões seguras e criptografadas em trânsito.
- **Cache & CDN**: Cloudflare na frente para DNS, SSL/TLS flexível/estrito, proxy de segurança e proteção contra DDoS.
