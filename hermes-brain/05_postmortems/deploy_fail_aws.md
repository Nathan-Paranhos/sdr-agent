# Postmortem #001: Erro de Permissão IAM no AWS ECS

## Problema
O deploy no ECS falhou com erro de acesso negado ao tentar baixar imagens do AWS ECR (Elastic Container Registry).

## Causa Raiz
A task execution role associada ao ECS Task Definition não possuía a policy `AmazonEC2ContainerRegistryReadOnly` anexada.

## Solução
1. Acesse o IAM Console.
2. Locate a role de execução da tarefa do ECS.
3. Anexe a policy de leitura do ECR (`AmazonEC2ContainerRegistryReadOnly`).
4. Re-execute o deploy no ECS.
