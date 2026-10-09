import util from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[process.env.MYBOX_LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, args) {
  if (LEVELS[level] < CURRENT) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${scope ? `${scope}: ` : ''}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  const msg = util.format(...args);
  stream.write(line + msg + '\n');
}

export function createLogger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
