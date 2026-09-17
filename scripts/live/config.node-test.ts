import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, selectTargets, resultExitCode } from './config.js';

const target = {
  id: 'example-native', label: 'Example', route: 'native', enabled: true,
  scenario: 'conversation', credential: { env: 'OPENAI_API_KEY', keychainAccount: 'llm-provider:openai' },
  profile: { providerId: 'openai', model: 'test-model', baseUrl: 'https://api.openai.com/v1' },
};
const config = (targets: unknown[]) => ({ version: 1, updated: '2026-09-17', sources: [], targets });

test('matrix includes only enabled targets while explicit selection keeps disabled reasons', () => {
  const parsed = parseConfig(config([target, { ...target, id: 'absent-app', enabled: false, reason: 'Absent from app catalog' }]));
  assert.deepEqual(selectTargets(parsed).map(t => t.id), ['example-native']);
  assert.equal(selectTargets(parsed, 'absent-app')[0]?.reason, 'Absent from app catalog');
  assert.throws(() => selectTargets(parsed, 'typo'), /Unknown target/);
});

test('ambiguous IDs and disabled targets without evidence are rejected before credentials', () => {
  assert.throws(() => parseConfig(config([target, target])), /Duplicate target/);
  assert.throws(() => parseConfig(config([{ ...target, enabled: false }])), /reason/);
  assert.throws(() => parseConfig(config([{ ...target, profile: { ...target.profile, apiKey: 'not-allowed' } }])), /Unrecognized/);
});

test('missing credentials never turn a selected suite green', () => {
  assert.equal(resultExitCode([{ status: 'passed' }]), 0);
  assert.equal(resultExitCode([{ status: 'unavailable' }]), 2);
  assert.equal(resultExitCode([{ status: 'disabled' }]), 2);
  assert.equal(resultExitCode([{ status: 'passed' }, { status: 'failed' }]), 1);
  assert.equal(resultExitCode([]), 2);
});

test('Responses reasoning cannot be configured to claim Chat Completions coverage', () => {
  assert.throws(() => parseConfig(config([{ ...target, scenario: 'responses-reasoning', profile: { ...target.profile, openAiApiMode: 'chat_completions' } }])), /Responses/);
});

test('legacy scenarios reject provider changes that would silently skip or use another endpoint', () => {
  for (const scenario of ['responses-reasoning', 'native-openai-tools']) {
    assert.throws(() => parseConfig(config([{ ...target, scenario, profile: { providerId: 'litellm_proxy', model: 'openai/test' } }])), /does not support/);
    assert.throws(() => parseConfig(config([{ ...target, scenario, route: 'openhands-eval' }])), /native route/);
    assert.throws(() => parseConfig(config([{ ...target, scenario, profile: { ...target.profile, baseUrl: 'https://proxy.example.test/v1' } }])), /cannot honor/);
  }
  assert.throws(() => parseConfig(config([{ ...target, scenario: 'native-gemini-tools' }])), /does not support/);
  assert.throws(() => parseConfig(config([{ ...target, scenario: 'deepseek-accounting' }])), /does not support/);
  assert.throws(() => parseConfig(config([{ ...target, scenario: 'anthropic-cache' }])), /does not support/);
  assert.throws(() => parseConfig(config([{ ...target, scenario: 'examples', profile: { providerId: 'deepseek', model: 'deepseek-flash' } }])), /does not support/);
});

test('cache scenario retains its supported native and explicit proxy routes', () => {
  const cache = { ...target, scenario: 'anthropic-cache', route: 'openhands-eval', profile: { providerId: 'litellm_proxy', model: 'anthropic/claude-haiku-4-5-20251001', baseUrl: 'https://llm-proxy.eval.all-hands.dev/v1' } };
  assert.equal(parseConfig(config([cache])).targets[0]?.profile.providerId, 'litellm_proxy');
  assert.equal(parseConfig(config([{ ...target, scenario: 'responses-reasoning' }])).targets[0]?.scenario, 'responses-reasoning');
});
