export type CondensationScenario = 'size' | 'tokens' | 'thinking' | 'forced';

/** An explicit override, never part of the ordinary --all model matrix. */
export function parseCondensationOption(args: readonly string[]): CondensationScenario | null {
  const indices = args.flatMap((arg, index) => arg === '--condensation' ? [index] : []);
  if (indices.length === 0) return null;
  if (!args.includes('--target') || args.some(arg => ['--all', '--list', '--matrix'].includes(arg))) throw new Error('--condensation requires --target ID');
  const value = args[indices[0]! + 1];
  if (indices.length !== 1 || !['size', 'tokens', 'thinking', 'forced'].includes(value ?? '')) throw new Error('Choose one condensation scenario: size, tokens, thinking, or forced');
  return value as CondensationScenario;
}
