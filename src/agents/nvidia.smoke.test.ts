import { describe, expect, it } from 'vitest';
import { CommerceAgent } from './commerceAgent';

const runLive = process.env.RUN_NVIDIA_SMOKE === '1';
const liveIt = runLive ? it : it.skip;

describe('NVIDIA live smoke test', () => {
  liveIt('returns a schema-validated CommerceDecision', async () => {
    expect(process.env.NVIDIA_API_KEY).toBeTruthy();

    const agent = CommerceAgent.createWithNVIDIAFromEnv();

    const result = await agent.proposeDecision(
      'opp-nvidia-smoke-001',
      [
        'Synthetic demo business context.',
        'A customer qualifies for a promotional incentive.',
        'Propose a CREATE_PAYMENT action for USD 25.00.',
        'Use recipient customer-demo-001.',
        'This is synthetic hackathon data only.',
      ].join(' ')
    );

    if (!result.success) {
      throw result.error;
    }

    expect(result.decision.opportunityId).toBe('opp-nvidia-smoke-001');
    expect(result.decision.action).toBe('CREATE_PAYMENT');
    expect(result.decision.amount).toBe(2500);
    expect(result.decision.currency).toBe('USD');
    expect(result.decision.recipient).toBe('customer-demo-001');

    console.log('NVIDIA_SMOKE_TEST=PASS');
  }, 30_000);
});
