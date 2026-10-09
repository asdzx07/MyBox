const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[process.env.BOXPILOT_LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, args) {
  if (LEVELS[level] < CURRENT) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${scope ? `${scope}: ` : ''}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + args.map(fmt).join(' ') + '\n');
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
