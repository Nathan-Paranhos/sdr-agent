import { spawn } from 'node:child_process';

const restartDelayMs = Number(process.env.SDR_AGENT_RESTART_DELAY_MS ?? 5000);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let child = null;
let stopping = false;
let restartTimer = null;

function scheduleRestart(reason) {
  if (stopping || restartTimer) return;

  console.error(`[sdr-agent:forever] processo saiu (${reason}); reiniciando em ${restartDelayMs}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start();
  }, restartDelayMs);
}

function start() {
  console.log('[sdr-agent:forever] iniciando npm run dev');

  child = spawn(npmCommand, ['run', 'dev'], {
    stdio: 'inherit',
    env: process.env
  });

  child.once('error', (err) => {
    child = null;
    scheduleRestart(err.message);
  });

  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(code ?? 0);
    }
    scheduleRestart(`code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
}

function stop(signal) {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);

  if (child) {
    child.kill(signal);
    return;
  }

  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[sdr-agent:forever] erro no supervisor:', err);
  scheduleRestart('supervisor_uncaught_exception');
});
process.on('unhandledRejection', (err) => {
  console.error('[sdr-agent:forever] promise rejeitada no supervisor:', err);
});

start();
