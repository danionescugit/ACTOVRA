// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Home from './page';

describe('ACTOVRA Payout Intelligence Dashboard (UX-05 Final Product UI)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders initial dashboard hero with 1,000 recipients, $147,930.75 net, and 98.3% review reduction', () => {
    render(<Home />);

    // Branding & Heading
    expect(screen.getAllByText('ACTOVRA').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('October 2026 Affiliate Settlement')).toBeTruthy();
    expect(screen.getByText('Payout distribution')).toBeTruthy();
    expect(screen.getByText('Ready to pay')).toBeTruthy();
    expect(screen.getByText('Needs your review')).toBeTruthy();
    expect(screen.getByText('Automatically held')).toBeTruthy();

    // Key Stats
    expect(screen.getByText('98.3%')).toBeTruthy();
    expect(screen.getByText('Review Reduction')).toBeTruthy();
    expect(screen.getAllByText('1000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$147,930.75').length).toBeGreaterThanOrEqual(1);

    // Triad Segments
    expect(screen.getAllByText('$140,594.47').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$5,527.08').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$1,834.20').length).toBeGreaterThanOrEqual(1);
  });

  it('allows independent authorization of Ready Batch #1 (917 payees, $140,594.47) while 17 exceptions remain unresolved', () => {
    render(<Home />);

    // 17 exceptions are unresolved, but Ready Batch #1 can be authorized immediately!
    const authorizeReadyBtn = screen.getByRole('button', {
      name: /Review & authorize 917 payouts/i,
    });
    expect(authorizeReadyBtn).toBeTruthy();

    // Click Authorize Ready Batch button -> Opens modal
    fireEvent.click(authorizeReadyBtn);
    expect(screen.getByRole('heading', { name: /Authorize Ready Batch #1/i })).toBeTruthy();
    expect(
      screen.getByText(/Unresolved exceptions do not hold back routine payouts/i)
    ).toBeTruthy();

    // Confirm in modal
    const confirmBtn = screen.getByRole('button', {
      name: /Authorize 917 Payouts — \$140,594\.47/i,
    });
    fireEvent.click(confirmBtn);

    // Modal closes and authorized banner is rendered
    expect(screen.getByText('Ready Batch #1 Authorized')).toBeTruthy();
    expect(screen.getAllByText(/917 payees/i).length).toBeGreaterThanOrEqual(1);
  });

  it('opens Actionable Exception Review Drawer and displays Sarah Jenkins playbook with 3.89x surge and human decision disclaimer', () => {
    render(<Home />);

    // Click Inspect Exceptions
    const inspectExceptionsBtn = screen.getByRole('button', { name: /Review 17 exceptions/i });
    fireEvent.click(inspectExceptionsBtn);

    // Modal opens
    expect(screen.getByText('Actionable Exception Review Playbook')).toBeTruthy();
    expect(screen.getAllByText(/Sarah Jenkins/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$428.70').length).toBeGreaterThanOrEqual(1);

    // Plain-language sections
    expect(screen.getByText('Issue Summary')).toBeTruthy();
    expect(screen.getByText('Why It Matters')).toBeTruthy();
    expect(screen.getByText('What ACTOVRA Found')).toBeTruthy();
    expect(screen.getByText('What You Need To Verify Before Approving')).toBeTruthy();
    expect(screen.getByText('Where To Verify Evidence')).toBeTruthy();
    expect(screen.getByText('Calculated Amount Breakdown')).toBeTruthy();

    // Waterfall numbers
    expect(screen.getByText('$512.40')).toBeTruthy();
    expect(screen.getByText('-$63.70')).toBeTruthy();
    expect(screen.getByText('-$20.00')).toBeTruthy();

    // Assessment source & decision disclaimer
    expect(screen.getAllByText(/NVIDIA Nemotron 3\.5/i).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText(
        /You make the final decision\. AI provides intelligence; deterministic mandates provide safety; human operators authorize disbursements\./i
      ).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('displays Marcus Chen security playbook with recent destination change (1 day ago) and high attention', () => {
    render(<Home />);

    fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

    // Select Marcus Chen
    const marcusBtn = screen.getByRole('button', { name: /Marcus Chen/i });
    fireEvent.click(marcusBtn);

    expect(screen.getAllByText(/Marcus Chen/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/HIGH ATTENTION \(85\/100\)/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 day ago/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/account takeover/i).length).toBeGreaterThanOrEqual(1);
  });

  it('forms Reviewed Batch #2 upon resolving exceptions and allows independent authorization of Batch #2', () => {
    render(<Home />);

    // Apply canonical scenario (10 approved, 7 held)
    const applyScenarioBtn = screen.getByRole('button', {
      name: /Apply Canonical Scenario \(10 Approved \/ 7 Held\)/i,
    });
    fireEvent.click(applyScenarioBtn);

    // Reviewed Batch #2 now appears in the UI
    expect(screen.getAllByText(/Reviewed Batch #2/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$3,728.66').length).toBeGreaterThanOrEqual(1);

    // Authorize Reviewed Batch #2
    const authBatch2Btn = screen.getByRole('button', {
      name: /Authorize Reviewed Batch \(10\)/i,
    });
    fireEvent.click(authBatch2Btn);

    // Confirm in modal
    const confirmBatch2Btn = screen.getByRole('button', {
      name: /Authorize 10 Payouts — \$3,728\.66/i,
    });
    fireEvent.click(confirmBatch2Btn);

    // Batch #2 authorized banner is displayed
    expect(screen.getAllByText(/Batch #2 Authorized/i).length).toBeGreaterThanOrEqual(1);
  });

  it('opens Rule-Held Payouts Inspector showing 66 held payees ($1,834.20) and automated carry-forward policy', () => {
    render(<Home />);

    const inspectHeldBtn = screen.getByRole('button', {
      name: /View 66 held payouts/i,
    });
    fireEvent.click(inspectHeldBtn);

    expect(screen.getByText('Rule-Held Payouts Inspector')).toBeTruthy();
    expect(screen.getByText(/Automated Carry-Forward Enforcement/i)).toBeTruthy();
    expect(screen.getAllByText(/John Doe/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\$42\.16/i).length).toBeGreaterThanOrEqual(1);
  });

  it('Reset Demo button cleanly restores baseline state', () => {
    render(<Home />);

    // Apply canonical scenario and authorize
    fireEvent.click(
      screen.getByRole('button', { name: /Apply Canonical Scenario \(10 Approved \/ 7 Held\)/i })
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Review & authorize 917 payouts/i })
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Authorize 917 Payouts — \$140,594\.47/i })
    );
    expect(screen.getByText('Ready Batch #1 Authorized')).toBeTruthy();

    // Click Reset Demo
    fireEvent.click(screen.getByRole('button', { name: /Reset Demo/i }));

    // Back to initial state
    expect(
      screen.getByRole('button', { name: /Review & authorize 917 payouts/i })
    ).toBeTruthy();
    expect(screen.queryByText('Ready Batch #1 Authorized')).toBeNull();
  });

  it('switches between sidebar navigation tabs (Overview, Exceptions, Recipients, Audit Log, Financial Controls)', () => {
    render(<Home />);

    // Switch to Exceptions
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar Exceptions' }));
    expect(screen.getByText('Exception Intelligence Workspace')).toBeTruthy();

    // Switch to Recipients
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar Recipients' }));
    expect(screen.getByText('All Payout Recipients Ledger')).toBeTruthy();

    // Switch to Audit Log
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar Audit Log' }));
    expect(screen.getByText('Financial Operations Audit Trail')).toBeTruthy();

    // Switch to Financial Controls
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar Financial Controls' }));
    expect(screen.getByText('Deterministic Financial Mandate Engine')).toBeTruthy();

    // Switch back to Overview
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar Overview' }));
    expect(screen.getByText('October 2026 Affiliate Settlement')).toBeTruthy();
    expect(screen.getByText('Payout distribution')).toBeTruthy();
  });

  it('switches between Payout Intelligence and Single Payment Demo tabs seamlessly', () => {
    render(<Home />);

    // In Payout Intelligence initially
    expect(screen.getByText('October 2026 Affiliate Settlement')).toBeTruthy();

    // Switch to Single Payment Demo
    fireEvent.click(screen.getByRole('button', { name: /Single Payment Demo/i }));
    expect(screen.getByText('Policy Guard Active')).toBeTruthy();

    // Switch back to Payout Intelligence
    fireEvent.click(screen.getByRole('button', { name: /Payout Intelligence/i }));
    expect(screen.getByText('October 2026 Affiliate Settlement')).toBeTruthy();
  });

  it('renders judge-facing Recent PayPal Execution card on Overview with PAYOUT-06 proof and clear distinction from 917-payee batch', () => {
    render(<Home />);

    // Recent PayPal Execution Card
    expect(screen.getByTestId('recent-paypal-execution')).toBeTruthy();
    expect(screen.getByText('Recent PayPal Execution')).toBeTruthy();
    expect(screen.getByText('SANDBOX · INTEGRATION PROOF')).toBeTruthy();
    expect(screen.getByText('$2.00 USD')).toBeTruthy();
    expect(screen.getByText('2 recipients')).toBeTruthy();
    expect(screen.getByText('✓ 2 completed')).toBeTruthy();
    expect(screen.getByText('0 pending')).toBeTruthy();
    expect(screen.getByText('0 failed')).toBeTruthy();
    expect(screen.getByText('H6YTQ7QCBF4RU')).toBeTruthy();
    expect(screen.getByText('✓ Reconciled with PayPal')).toBeTruthy();
    expect(screen.getByText('Executed Oct 31, 2026')).toBeTruthy();

    // Critical truthfulness distinction
    expect(
      screen.getByText(/Sandbox integration proof · Separate from the 917-payee demo batch/i)
    ).toBeTruthy();

    // Toggle details
    fireEvent.click(screen.getByTestId('toggle-paypal-details'));
    expect(screen.getByTestId('paypal-proof-details')).toBeTruthy();
    expect(screen.getByText(/Total PayPal Fees/i)).toBeTruthy();
    expect(screen.getByText('$0.04 USD')).toBeTruthy();
    expect(screen.getByText(/7CK89601G2473524M/i)).toBeTruthy();
    expect(screen.getByText(/2H839828DF5533320/i)).toBeTruthy();
  });
});
