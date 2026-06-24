import { describe, expect, it, vi } from 'vitest';

import { disableLogger, getLogger, isEnabledFor, LogLevel, setupLogging } from '../index.js';

describe('logger', () => {
  it('suppresses LiteLLM/OpenAI loggers below error by default', () => {
    for (const name of ['litellm', 'LiteLLM', 'openai']) {
      expect(isEnabledFor(name, LogLevel.INFO)).toBe(false);
      expect(isEnabledFor(name, LogLevel.WARN)).toBe(false);
      expect(isEnabledFor(name, LogLevel.ERROR)).toBe(true);
    }
  });

  it('returns module loggers that honor configured levels', () => {
    const logger = getLogger('openhands.test.logger');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      setupLogging({ level: LogLevel.INFO });
      logger.debug('hidden');
      logger.info('visible %s', 'message');

      expect(debug).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith('[openhands.test.logger] visible message');
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

  it('can disable a specific logger', () => {
    disableLogger('custom.disabled', LogLevel.ERROR);

    expect(isEnabledFor('custom.disabled', LogLevel.INFO)).toBe(false);
    expect(isEnabledFor('custom.disabled', LogLevel.ERROR)).toBe(true);
  });
});
