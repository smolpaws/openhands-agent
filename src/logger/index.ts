import { format } from 'node:util';

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  CRITICAL = 50,
}

export interface Logger {
  readonly name: string;
  debug(message: string, ...args: readonly unknown[]): void;
  info(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, ...args: readonly unknown[]): void;
}

export interface LoggingOptions {
  readonly level?: LogLevel;
}

const loggerLevels = new Map<string, LogLevel>();
let rootLevel = envLogLevel();

for (const name of ['litellm', 'LiteLLM', 'openai']) {
  disableLogger(name, LogLevel.ERROR);
}
for (const name of ['httpcore', 'httpx', 'libtmux']) {
  disableLogger(name, LogLevel.WARN);
}

export function setupLogging(options: LoggingOptions = {}): void {
  rootLevel = options.level ?? envLogLevel();
}

export function disableLogger(name: string, level: LogLevel = LogLevel.CRITICAL): void {
  loggerLevels.set(name, level);
}

export function isEnabledFor(name: string, level: LogLevel): boolean {
  return level >= (loggerLevels.get(name) ?? rootLevel);
}

export function getLogger(name: string): Logger {
  return {
    name,
    debug: (message, ...args) => emit(name, LogLevel.DEBUG, message, args),
    info: (message, ...args) => emit(name, LogLevel.INFO, message, args),
    warn: (message, ...args) => emit(name, LogLevel.WARN, message, args),
    error: (message, ...args) => emit(name, LogLevel.ERROR, message, args),
  };
}

function emit(name: string, level: LogLevel, message: string, args: readonly unknown[]): void {
  if (!isEnabledFor(name, level)) {
    return;
  }
  const rendered = `[${name}] ${format(message, ...args)}`;
  switch (level) {
    case LogLevel.DEBUG:
      console.debug(rendered);
      break;
    case LogLevel.INFO:
      console.info(rendered);
      break;
    case LogLevel.WARN:
      console.warn(rendered);
      break;
    case LogLevel.ERROR:
    case LogLevel.CRITICAL:
      console.error(rendered);
      break;
  }
}

function envLogLevel(): LogLevel {
  if (truthyEnv(process.env.DEBUG)) {
    return LogLevel.DEBUG;
  }
  const value = process.env.LOG_LEVEL?.toUpperCase();
  switch (value) {
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'WARNING':
    case 'WARN':
      return LogLevel.WARN;
    case 'ERROR':
      return LogLevel.ERROR;
    case 'CRITICAL':
      return LogLevel.CRITICAL;
    case 'INFO':
    case undefined:
      return LogLevel.INFO;
    default:
      return LogLevel.INFO;
  }
}

function truthyEnv(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.toLowerCase());
}
