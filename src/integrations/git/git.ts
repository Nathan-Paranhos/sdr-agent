import { simpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs/promises';
import { log } from '../../config/logger.js';

const git = simpleGit();

export async function initGitConfig(): Promise<void> {
  try {
    // Configure local repository git user to avoid commit errors
    await git.addConfig('user.name', 'Genisis Bot', false, 'local');
    await git.addConfig('user.email', 'bot@genisis.ai', false, 'local');
    log.info('Git local configurado com sucesso para o Genisis');
  } catch (err) {
    log.warn({ err }, 'Nao foi possivel configurar git localmente (talvez fora de um repositorio git)');
  }
}

export async function commitPostmortem(filePath: string): Promise<void> {
  try {
    await initGitConfig();
    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    await git.add(relativePath);
    await git.commit(`Hermes Auto-Learning: adicionado postmortem ${path.basename(filePath)}`);
    log.info({ relativePath }, 'Commit de postmortem no Git concluido com sucesso');
  } catch (err) {
    log.error({ err, filePath }, 'Erro ao commitar postmortem no Git');
  }
}

export async function revertLastLearningCommit(): Promise<string | null> {
  try {
    await initGitConfig();
    const logs = await git.log({ maxCount: 100 });
    const lastLearningCommit = logs.all.find((c) => c.message.includes('Hermes Auto-Learning:'));
    if (!lastLearningCommit) {
      log.warn('Nenhum commit de aprendizado do Hermes encontrado para reverter');
      return null;
    }

    log.info({ hash: lastLearningCommit.hash, message: lastLearningCommit.message }, 'Revertendo ultimo commit de aprendizado');
    
    // Perform git revert --no-edit
    await git.revert(lastLearningCommit.hash, ['--no-edit']);
    
    // Extract filename from commit message to clean it up if not fully deleted
    const match = /adicionado postmortem (bug_\d+\.md)/.exec(lastLearningCommit.message);
    if (match?.[1]) {
      const filename = match[1];
      const filePath = path.resolve(process.cwd(), 'hermes-brain', '05_postmortems', filename);
      try {
        await fs.unlink(filePath);
        log.info({ filePath }, 'Postmortem deletado do disco apos revert do git');
      } catch (e) {
        // expected if git revert already removed it
      }
    }

    return lastLearningCommit.hash;
  } catch (err) {
    log.error({ err }, 'Erro ao reverter ultimo commit de aprendizado no Git');
    throw err;
  }
}
