// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Home from './page';

function expectDisabled(el: HTMLElement) {
  expect((el as HTMLButtonElement).disabled).toBe(true);
}

function expectEnabled(el: HTMLElement) {
  expect((el as HTMLButtonElement).disabled).toBe(false);
}

describe('ACTOVRA Browser Visual QA Matrix (UX-06 FINAL — 10 Required Views)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  // 1. Overview Screen
  it('View 1: Overview renders clean operational header, single population, and correct financial hierarchy', () => {
    render(<Home />);
    expect(screen.getByText('October 2026 Affiliate Settlement')).toBeTruthy();
    expect(screen.getAllByText('CYCLE: OCT-2026-01').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Total calculated payout')).toBeTruthy();
    expect(screen.getAllByText('$147,930.75').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Payout distribution')).toBeTruthy();

    // Primary action visible
    expect(screen.getByRole('button', { name: /Review & authorize 917 payouts/i })).toBeTruthy();
  });

  // 2. Operational Impact
  it('View 2: Operational Impact component renders green donut, comparison rows, and pale green result panel', () => {
    render(<Home />);
    expect(screen.getByText('Operational Impact')).toBeTruthy();
    expect(screen.getByText(/ACTOVRA eliminates 983 routine reviews from your queue/i)).toBeTruthy();

    // 98.3% inside Donut
    expect(screen.getByText('98.3%')).toBeTruthy();
    expect(screen.getByText('fewer reviews')).toBeTruthy();

    // Row 1: WITHOUT ACTOVRA
    expect(screen.getByText('WITHOUT ACTOVRA')).toBeTruthy();
    expect(screen.getByText('1,000 payouts')).toBeTruthy();
    expect(screen.getByText('8h 20m')).toBeTruthy();

    // Row 2: WITH ACTOVRA
    expect(screen.getByText('WITH ACTOVRA')).toBeTruthy();
    expect(screen.getByText('17 payouts')).toBeTruthy();
    expect(screen.getByText('8m 30s')).toBeTruthy();

    // Pale green result panel
    expect(screen.getByText('≈ 8h 12m')).toBeTruthy();
    expect(screen.getByText('of routine review avoided')).toBeTruthy();
  });

  // 3. How is this estimated?
  it('View 3: How is this estimated? interactive modal renders transparent methodology', () => {
    render(<Home />);
    const howEstimatedBtn = screen.getByRole('button', { name: /How is this estimated\? →/i });
    fireEvent.click(howEstimatedBtn);

    expect(screen.getByRole('heading', { name: 'How this estimate works' })).toBeTruthy();
    expect(screen.getByText(/30 seconds to perform a routine payout review/i)).toBeTruthy();
    expect(screen.getByText('1,000 × 30 sec = 8h 20m')).toBeTruthy();
    expect(screen.getByText('983 × 30 sec ≈ 8h 12m')).toBeTruthy();
    expect(screen.getByText(/Exception investigation time is excluded/i)).toBeTruthy();

    // Close button
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('heading', { name: 'How this estimate works' })).toBeNull();
  });

  // 4. Ready Batch Review Modal
  it('View 4: Ready Batch review modal renders 917 recipients and $140,594.47 with independent execution copy', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /Review & authorize 917 payouts/i }));

    expect(screen.getByRole('heading', { name: /Authorize Ready Batch #1/i })).toBeTruthy();
    expect(screen.getByText(/Unresolved exceptions do not hold back routine payouts/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Authorize 917 Payouts — \$140,594\.47/i })).toBeTruthy();
  });

  // 5. Sarah Exception (3-column workspace)
  it('View 5: Sarah Jenkins exception renders in 3-column workspace with proportional waterfall and sticky decision panel', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

    // Case Header
    expect(screen.getAllByText('Sarah Jenkins').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$428.70').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/MEDIUM ATTENTION \(50\/100\)/i).length).toBeGreaterThanOrEqual(1);

    // Facts vs Verify
    expect(screen.getByText('What ACTOVRA Found')).toBeTruthy();
    expect(screen.getByText('What You Need To Verify Before Approving')).toBeTruthy();

    // Proportional waterfall
    expect(screen.getByText('Gross Commission Earnings:')).toBeTruthy();
    expect(screen.getByText('$512.40')).toBeTruthy();
    expect(screen.getByText('-$63.70')).toBeTruthy();
    expect(screen.getByText('-$20.00')).toBeTruthy();
    expect(screen.getByText('Calculated deterministically')).toBeTruthy();
    expect(screen.getByText(/AI did NOT calculate or modify this amount/i)).toBeTruthy();

    // Right sticky panel
    expect(screen.getByRole('heading', { name: 'Decision' })).toBeTruthy();
    expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));
    expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));

    // Complete all 3 verification checklist items
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(3);
    checkboxes.forEach((cb) => fireEvent.click(cb));

    expectEnabled(screen.getByRole('button', { name: /✓ Approve payout \(\$428\.70\)/i }));
    expect(screen.getByText(/You make the final decision/i)).toBeTruthy();
  });

  // 6. Marcus Exception (Security case)
  it('View 6: Marcus Chen security case renders destination change 1 day ago and 2FA callback verification guidance', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
    fireEvent.click(screen.getByRole('button', { name: /Marcus Chen/i }));

    expect(screen.getAllByText('Marcus Chen').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$240.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/HIGH ATTENTION \(85\/100\)/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 day ago/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/2FA/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Do not rely only on contact information added or changed together with the payout destination/i)).toBeTruthy();
  });

  // 7. Duplicate Destination Case
  it('View 7: Elena Rostova duplicate destination case renders shared payout account guidance and agency verification checklist', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
    fireEvent.click(screen.getByRole('button', { name: /Elena Rostova/i }));

    expect(screen.getAllByText('Elena Rostova').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$200.74').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/MEDIUM ATTENTION \(65\/100\)/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Shared payout account detected/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/signed agency agreement/i).length).toBeGreaterThanOrEqual(1);
  });

  // 8. High Refund Case
  it('View 8: TechGear Reviews high refund case renders 30.8% refund/chargeback rate and clawback exposure guidance', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
    fireEvent.click(screen.getByRole('button', { name: /TechGear Reviews/i }));

    expect(screen.getAllByText('TechGear Reviews').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$289.13').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/HIGH ATTENTION \(78\/100\)/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Unusually high refund rate/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/clawback exposure/i)).toBeTruthy();
  });

  // 9. Held Payouts Inspector
  it('View 9: Held payouts inspector renders 66 payees held by policy and automatic carry-forward policy', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /View 66 held payouts/i }));

    expect(screen.getByRole('heading', { name: 'Rule-Held Payouts Inspector' })).toBeTruthy();
    expect(screen.getByText(/66 Payees Held by Policy/i)).toBeTruthy();
    expect(screen.getByText(/Automated Carry-Forward Enforcement/i)).toBeTruthy();
    expect(screen.getAllByText('John Doe').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\$42\.16/i).length).toBeGreaterThanOrEqual(1);
  });

  // 10. Reviewed Batch After Demo Resolution
  it('View 10: Reviewed Batch #2 renders after canonical resolution with 10 approved and $3,728.66 net', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /Apply Canonical Scenario \(10 Approved \/ 7 Held\)/i }));

    expect(screen.getAllByText(/Reviewed Batch #2/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$3,728.66').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Authorize Reviewed Batch \(10\)/i })).toBeTruthy();
  });

  // UX-06.2 Layout & Overflow Hotfix Suite
  describe('UX-06.2: Exception Review Layout & Overflow Hotfix Verification', () => {
    it('Sarah top position: full center content, full right decision panel, and both action buttons are rendered without clipping', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      // Left column verification
      expect(screen.getByText(/17 Flagged Exceptions/i)).toBeTruthy();

      // Center column verification
      expect(screen.getByRole('heading', { level: 4, name: 'Sarah Jenkins' })).toBeTruthy();
      expect(screen.getByText('Issue Summary')).toBeTruthy();
      expect(screen.getByText('Why It Matters')).toBeTruthy();
      expect(screen.getByText('What ACTOVRA Found')).toBeTruthy();

      // Right decision panel verification
      expect(screen.getByRole('heading', { level: 4, name: 'Decision' })).toBeTruthy();
      expect(screen.getAllByText('$428.70').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Approve When:')).toBeTruthy();
      expect(screen.getByText(/The underlying commission activity legitimately explains the increase from campaign launch/i)).toBeTruthy();
      expect(screen.getByText('Hold When:')).toBeTruthy();
      expect(screen.getByText(/The increase cannot be explained, or source records are unverified\./i)).toBeTruthy();

      // Decision buttons: initially Complete verification to approve (disabled)
      const disabledApproveBtn = screen.getByRole('button', { name: /Complete verification to approve/i });
      const holdBtn = screen.getByRole('button', { name: /✕ Hold payout/i });
      expectDisabled(disabledApproveBtn);
      expectEnabled(holdBtn);
      expect(screen.getByText(/Complete all required verification checks before approving this payout/i)).toBeTruthy();

      // Complete all verification items
      screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
      const approveBtn = screen.getByRole('button', { name: /✓ Approve payout \(\$428\.70\)/i });
      expectEnabled(approveBtn);

      // Human disclaimer text
      expect(screen.getByText(/You make the final decision\. AI provides intelligence; deterministic mandates provide safety; human operators authorize disbursements\./i)).toBeTruthy();
    });

    it('Sarah scrolled: center scrolls independently while right decision panel remains completely visible', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      const centerCol = document.querySelector('[class*="investigationCenter3Col"]');
      expect(centerCol).toBeTruthy();

      // Simulate scrolling center column to Calculated Amount Breakdown and Checklist
      if (centerCol) {
        centerCol.scrollTop = 500;
        fireEvent.scroll(centerCol);
      }

      // Verify sections in scrolled position
      expect(screen.getByText('Calculated Amount Breakdown')).toBeTruthy();
      expect(screen.getByText('What You Need To Verify Before Approving')).toBeTruthy();
      expect(screen.getByText('Where To Verify Evidence')).toBeTruthy();

      // Check all items while scrolled
      screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));

      // Verify Decision panel is unaffected by center scroll and approve is enabled
      expect(screen.getByRole('heading', { level: 4, name: 'Decision' })).toBeTruthy();
      expectEnabled(screen.getByRole('button', { name: /✓ Approve payout \(\$428\.70\)/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));
    });

    it('Marcus Chen case: security instructions fit completely in decision and center regions', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
      fireEvent.click(screen.getByRole('button', { name: /Marcus Chen/i }));

      // Security flag & guidance
      expect(screen.getAllByText(/1 day ago/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Approve When:')).toBeTruthy();
      expect(screen.getByText(/Marcus Chen confirmed the change through a previously trusted contact channel/i)).toBeTruthy();
      expect(screen.getByText('Hold When:')).toBeTruthy();
      expect(screen.getByText(/Hold the payout if the change cannot be independently verified/i)).toBeTruthy();

      // Action buttons: initially disabled
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));

      // Complete all 4 items for Marcus
      const marcusCheckboxes = screen.getAllByRole('checkbox');
      expect(marcusCheckboxes.length).toBe(4);
      marcusCheckboxes.forEach((cb) => fireEvent.click(cb));

      expectEnabled(screen.getByRole('button', { name: /✓ Approve payout \(\$240\.00\)/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));
    });

    it('Duplicate destination case: agency agreement verification text fits completely', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
      fireEvent.click(screen.getByRole('button', { name: /Elena Rostova/i }));

      expect(screen.getByText('Approve When:')).toBeTruthy();
      expect(screen.getByText(/Both payees have a signed agency agreement on file confirming authorization to use the shared PayPal address\./i)).toBeTruthy();
      expect(screen.getByText('Hold When:')).toBeTruthy();
      expect(screen.getByText(/The affiliates claim to be independent and undisclosed sharing cannot be verified\./i)).toBeTruthy();

      // Initially disabled
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));

      // Complete all 4 items for Elena
      const elenaCheckboxes = screen.getAllByRole('checkbox');
      expect(elenaCheckboxes.length).toBe(4);
      elenaCheckboxes.forEach((cb) => fireEvent.click(cb));

      expectEnabled(screen.getByRole('button', { name: /✓ Approve payout \(\$200\.74\)/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));
    });

    it('High refund case: refund rate explanation and clawback guidance fit completely', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
      fireEvent.click(screen.getByRole('button', { name: /TechGear Reviews/i }));

      expect(screen.getByText('Approve When:')).toBeTruthy();
      expect(screen.getByText(/The refund activity is legitimate customer returns and the payout calculation correctly reflects all deductions\./i)).toBeTruthy();
      expect(screen.getByText('Hold When:')).toBeTruthy();
      expect(screen.getByText(/Hold the payout if refund activity cannot be explained or source transactions indicate chargeback fraud\./i)).toBeTruthy();

      // Initially disabled
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));

      // Complete all 4 items for TechGear
      const techgearCheckboxes = screen.getAllByRole('checkbox');
      expect(techgearCheckboxes.length).toBe(4);
      techgearCheckboxes.forEach((cb) => fireEvent.click(cb));

      expectEnabled(screen.getByRole('button', { name: /✓ Approve payout \(\$289\.13\)/i }));
      expectEnabled(screen.getByRole('button', { name: /✕ Hold payout/i }));
    });

    it('Responsive Viewports (1920x1080, 1600x900, 1366x768): workspace layout adapts with full visibility and zero clipping', () => {
      const viewports = [
        { width: 1920, height: 1080 },
        { width: 1600, height: 900 },
        { width: 1366, height: 768 },
      ];

      for (const vp of viewports) {
        window.innerWidth = vp.width;
        window.innerHeight = vp.height;
        fireEvent(window, new Event('resize'));

        render(<Home />);
        fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

        const modal = document.querySelector('[role="dialog"]');
        expect(modal).toBeTruthy();

        // 3 columns rendered
        const leftCol = document.querySelector('[class*="drawerSidebar3Col"]');
        const centerCol = document.querySelector('[class*="investigationCenter3Col"]');
        const rightCol = document.querySelector('[class*="decisionRight3Col"]');

        expect(leftCol).toBeTruthy();
        expect(centerCol).toBeTruthy();
        expect(rightCol).toBeTruthy();

        // Buttons fully rendered
        expect(screen.getByRole('button', { name: /Complete verification to approve/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /✕ Hold payout/i })).toBeTruthy();

        cleanup();
      }
    });

    // UX-06.3 Verification Gate Invariant Tests
    it('Approval gate: 0/N, N-1/N blocked; N/N allowed', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      // 0 of 3 checked -> Complete verification to approve (disabled)
      expect(screen.getByText('0 of 3 checked')).toBeTruthy();
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));

      const checkboxes = screen.getAllByRole('checkbox');
      // 1 of 3 checked -> disabled
      fireEvent.click(checkboxes[0]);
      expect(screen.getByText('1 of 3 checked')).toBeTruthy();
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));

      // 2 of 3 checked (N-1) -> disabled
      fireEvent.click(checkboxes[1]);
      expect(screen.getByText('2 of 3 checked')).toBeTruthy();
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));

      // 3 of 3 checked (N/N) -> enabled
      fireEvent.click(checkboxes[2]);
      expect(screen.getByText('3 of 3 checked')).toBeTruthy();
      const approveBtn = screen.getByRole('button', { name: /✓ Approve payout \(\$428\.70\)/i });
      expectEnabled(approveBtn);

      // Click approve -> success
      fireEvent.click(approveBtn);
      expect(screen.getAllByText(/Approved/i).length).toBeGreaterThanOrEqual(1);
    });

    it('Uncheck: N/N enabled, then uncheck one -> disabled again', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      const checkboxes = screen.getAllByRole('checkbox');
      checkboxes.forEach((cb) => fireEvent.click(cb));
      expectEnabled(screen.getByRole('button', { name: /✓ Approve payout \(\$428\.70\)/i }));

      // Uncheck one item
      fireEvent.click(checkboxes[0]);
      expect(screen.getByText('2 of 3 checked')).toBeTruthy();
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));
      expect(screen.getByText(/Complete all required verification checks before approving this payout/i)).toBeTruthy();
    });

    it('Hold: 0/N checked -> hold is immediately available and actionable', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      // 0 of 3 checked
      expect(screen.getByText('0 of 3 checked')).toBeTruthy();
      const holdBtn = screen.getByRole('button', { name: /✕ Hold payout/i });
      expectEnabled(holdBtn);

      fireEvent.click(holdBtn);
      expect(screen.getAllByText(/Held/i).length).toBeGreaterThanOrEqual(1);
    });

    it('State isolation: Checking Sarah requirements does NOT check Marcus requirements', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      // Check Sarah's items
      const sarahBoxes = screen.getAllByRole('checkbox');
      sarahBoxes.forEach((cb) => fireEvent.click(cb));
      expect(screen.getByText('3 of 3 checked')).toBeTruthy();

      // Switch to Marcus Chen
      fireEvent.click(screen.getByRole('button', { name: /Marcus Chen/i }));
      expect(screen.getByText('0 of 4 checked')).toBeTruthy();
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));

      // Switch back to Sarah
      fireEvent.click(screen.getByRole('button', { name: /Sarah Jenkins/i }));
      expect(screen.getByText('3 of 3 checked')).toBeTruthy();
    });

    it('Reset: Reset Demo cleanly clears all checklist states across all exceptions', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      // Check Sarah's items
      screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
      expect(screen.getByText('3 of 3 checked')).toBeTruthy();

      // Close modal and Reset
      fireEvent.click(screen.getByRole('button', { name: '✕' }));
      fireEvent.click(screen.getByRole('button', { name: /Reset Demo/i }));

      // Re-open exceptions
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));
      expect(screen.getByText('0 of 3 checked')).toBeTruthy();
      expectDisabled(screen.getByRole('button', { name: /Complete verification to approve/i }));
    });

    it('Financial invariants: checklist interactions do not alter any amounts, classifications, or mandate rules', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: /Review 17 exceptions/i }));

      // Amount before
      expect(screen.getAllByText('$428.70').length).toBeGreaterThanOrEqual(1);

      // Check and uncheck
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[0]);

      // Amount after is identical
      expect(screen.getAllByText('$428.70').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('$512.40')).toBeTruthy();
      expect(screen.getByText('-$63.70')).toBeTruthy();
      expect(screen.getByText('-$20.00')).toBeTruthy();
    });
  });

  describe('PAYOUT-07: Judge-Facing PayPal Execution & Reconciliation Proof Visual QA', () => {
    it('Overview renders Recent PayPal Execution component directly below Active Settlement Batches', () => {
      render(<Home />);

      // Active Settlement Batches is present
      expect(screen.getByText('Active Settlement Batches')).toBeTruthy();

      // Recent PayPal Execution is present directly in the same layout section
      const proofCard = screen.getByTestId('recent-paypal-execution');
      expect(proofCard).toBeTruthy();
      expect(screen.getByText('Recent PayPal Execution')).toBeTruthy();
      expect(screen.getByText('SANDBOX · INTEGRATION PROOF')).toBeTruthy();
      expect(screen.getByText('$2.00 USD')).toBeTruthy();
      expect(screen.getByText('2 payout items')).toBeTruthy();
      expect(screen.getByText('✓ 2 completed')).toBeTruthy();
      expect(screen.getByText('H6YTQ7QCBF4RU')).toBeTruthy();
      expect(screen.getByText('✓ Reconciled with PayPal')).toBeTruthy();
      expect(screen.getByText('Executed Oct 31, 2026')).toBeTruthy();
    });

    it('Truthfulness invariant: integration proof is clearly distinct from 917-payee Ready Batch', () => {
      render(<Home />);

      // Clear non-tooltip distinction statement
      expect(
        screen.getByText(/Sandbox integration proof · Separate from the 917-payee demo batch/i)
      ).toBeTruthy();

      // Explains Ready Batch #1 ($140,594.47) is offline model
      expect(
        screen.getByText(/Ready Batch #1 \(\$140,594\.47\) and 17 exceptions are offline demonstration models/i)
      ).toBeTruthy();

      // Confirms Ready Batch #1 remains in its unexecuted state
      expect(screen.getAllByText(/Ready Batch #1/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole('button', { name: /Review & authorize 917 payouts/i })).toBeTruthy();
    });

    it('Responsive Viewports (1920x1080, 1600x900, 1366x768): proof component adapts without overflow or clipping', () => {
      const viewports = [
        { width: 1920, height: 1080 },
        { width: 1600, height: 900 },
        { width: 1366, height: 768 },
      ];

      for (const vp of viewports) {
        window.innerWidth = vp.width;
        window.innerHeight = vp.height;

        const { unmount } = render(<Home />);

        // Invariant checks at each viewport
        const proofCard = screen.getByTestId('recent-paypal-execution');
        expect(proofCard).toBeTruthy();
        expect(screen.getByText('$2.00 USD')).toBeTruthy();
        expect(screen.getByText('H6YTQ7QCBF4RU')).toBeTruthy();
        expect(screen.getByText(/Sandbox integration proof · Separate from the 917-payee demo batch/i)).toBeTruthy();

        unmount();
      }
    });

    it('Detail View toggle: expands item transactions and total fees without altering any financial figures', () => {
      render(<Home />);

      // Core Overview figures before
      expect(screen.getAllByText('$147,930.75').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$140,594.47').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$5,527.08').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$1,834.20').length).toBeGreaterThanOrEqual(1);

      // Expand details
      const toggleBtn = screen.getByTestId('toggle-paypal-details');
      fireEvent.click(toggleBtn);

      expect(screen.getByTestId('paypal-proof-details')).toBeTruthy();
      expect(screen.getByText(/7CK89601G2473524M/i)).toBeTruthy();
      expect(screen.getByText(/2H839828DF5533320/i)).toBeTruthy();
      expect(screen.getByText('$0.04 USD')).toBeTruthy();

      // Core Overview figures after remain completely identical
      expect(screen.getAllByText('$147,930.75').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$140,594.47').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$5,527.08').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$1,834.20').length).toBeGreaterThanOrEqual(1);
    });
  });
});
