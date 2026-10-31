import { describe, it, expect } from 'vitest';
import { getReviewPlaybook } from './reviewPlaybooks';
import { generateSyntheticPayoutPopulation, classifyPayoutPopulation } from './index';

describe('ACTOVRA Actionable Exception Review Playbooks (UX-05)', () => {
  const population = generateSyntheticPayoutPopulation();
  const classified = classifyPayoutPopulation(population);

  it('generates Sarah Jenkins velocity playbook with 3.89x baseline and positive marketing campaign guidance', () => {
    const sarah = classified.find((i) => i.id === 'payout-042');
    expect(sarah).toBeDefined();
    if (!sarah) return;

    const playbook = getReviewPlaybook(sarah);
    expect(playbook.payoutItemId).toBe('payout-042');
    expect(playbook.affiliateName).toBe('Sarah Jenkins');
    expect(playbook.attentionLevel).toBe('MEDIUM');
    expect(playbook.riskScore).toBe(50);
    expect(playbook.assessmentSource).toContain('NVIDIA Nemotron 3.5');
    expect(playbook.issueSummary).toContain('Unusual payout increase');
    expect(playbook.whyItMatters).toContain('Velocity surges can indicate legitimate viral traffic or commission fraud');
    expect(playbook.whatActovraFound.some((f) => f.includes('3.89x'))).toBe(true);
    expect(playbook.whatYouNeedToVerify.length).toBeGreaterThanOrEqual(3);
    expect(playbook.whereToVerify).toContain('Marketing portal');
    expect(playbook.approveIf).toContain('campaign launch');
    expect(playbook.holdIf).toContain('unverified');
    expect(playbook.suggestedAction).toBe('APPROVE');
  });

  it('generates Marcus Chen security playbook with recent destination change (1 day ago) and high attention', () => {
    const marcus = classified.find((i) => i.id === 'payout-101');
    expect(marcus).toBeDefined();
    if (!marcus) return;

    const playbook = getReviewPlaybook(marcus);
    expect(playbook.payoutItemId).toBe('payout-101');
    expect(playbook.affiliateName).toBe('Marcus Chen');
    expect(playbook.attentionLevel).toBe('HIGH');
    expect(playbook.riskScore).toBe(85);
    expect(playbook.assessmentSource).toContain('NVIDIA Nemotron 3.5');
    expect(playbook.issueSummary).toContain('Payout destination changed recently');
    expect(playbook.whyItMatters).toContain('account takeover');
    expect(playbook.whatActovraFound.some((f) => f.includes('1 day ago'))).toBe(true);
    expect(playbook.whatYouNeedToVerify.some((s) => s.includes('2FA'))).toBe(true);
    expect(playbook.whereToVerify).toContain('Security event log');
    expect(playbook.approveIf).toContain('confirmed the change');
    expect(playbook.holdIf).toContain('Hold the payout');
    expect(playbook.suggestedAction).toBe('HOLD');
  });

  it('generates Elena Rostova duplicate destination playbook with shared agency billing account', () => {
    const elena = classified.find((i) => i.id === 'payout-201');
    expect(elena).toBeDefined();
    if (!elena) return;

    const playbook = getReviewPlaybook(elena);
    expect(playbook.payoutItemId).toBe('payout-201');
    expect(playbook.affiliateName).toBe('Elena Rostova');
    expect(playbook.attentionLevel).toBe('MEDIUM');
    expect(playbook.riskScore).toBe(65);
    expect(playbook.issueSummary).toContain('Shared payout account detected');
    expect(playbook.whyItMatters).toContain('collusion or undisclosed multi-accounting');
    expect(
      playbook.whatActovraFound.some(
        (f) => f.includes('shared-payout@creativestudio.io') || f.includes('billing@creativestudio.io')
      )
    ).toBe(true);
    expect(playbook.approveIf).toContain('agency agreement');
    expect(playbook.holdIf).toContain('independent and undisclosed');
  });

  it('generates high refund playbook for refund rate exceeding threshold', () => {
    const refundItem = classified.find((i) => i.id === 'payout-301');
    expect(refundItem).toBeDefined();
    if (!refundItem) return;

    const playbook = getReviewPlaybook(refundItem);
    expect(playbook.payoutItemId).toBe('payout-301');
    expect(playbook.attentionLevel).toBe('HIGH');
    expect(playbook.riskScore).toBe(78);
    expect(playbook.issueSummary).toContain('Unusually high refund rate');
    expect(playbook.whyItMatters).toContain('clawback exposure');
    expect(playbook.suggestedAction).toBe('HOLD');
  });
});
