type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

type Bindings = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, message: string, bindings?: Bindings): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    scope: 'codesync',
    message,
    ...bindings,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, bindings?: Bindings): void;
  info(message: string, bindings?: Bindings): void;
  warn(message: string, bindings?: Bindings): void;
  error(message: string, bindings?: Bindings): void;
  child(extra: Bindings): Logger;
}

export function createLogger(bindings: Bindings = {}): Logger {
  return {
    debug: (message, extra) => emit('debug', message, { ...bindings, ...extra }),
    info: (message, extra) => emit('info', message, { ...bindings, ...extra }),
    warn: (message, extra) => emit('warn', message, { ...bindings, ...extra }),
    error: (message, extra) => emit('error', message, { ...bindings, ...extra }),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger();
