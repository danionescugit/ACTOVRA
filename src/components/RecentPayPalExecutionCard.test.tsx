// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { RecentPayPalExecutionCard } from './RecentPayPalExecutionCard';

describe('RecentPayPalExecutionCard (PAYOUT-07 Judge-Facing Execution Proof)', () => {
  afterEach(() => {
    cleanup();
  });
  it('renders verified PAYOUT-06 execution summary with correct financial and batch data', () => {
    render(<RecentPayPalExecutionCard />);

    // Header & Proof Badge
    expect(screen.getByText('Recent PayPal Execution')).toBeTruthy();
    expect(screen.getByText('SANDBOX · INTEGRATION PROOF')).toBeTruthy();
    expect(screen.getByText('✓ SUCCESS')).toBeTruthy();

    // Financial Metrics
    expect(screen.getByText('$2.00 USD')).toBeTruthy();
    expect(screen.getByText('2 recipients')).toBeTruthy();

    // Reconciliation Breakdown
    expect(screen.getByText('✓ 2 completed')).toBeTruthy();
    expect(screen.getByText('0 pending')).toBeTruthy();
    expect(screen.getByText('0 failed')).toBeTruthy();

    // Batch Reference & Status
    expect(screen.getByText('PayPal Batch')).toBeTruthy();
    expect(screen.getByText('H6YTQ7QCBF4RU')).toBeTruthy();
    expect(screen.getByText('✓ Reconciled with PayPal')).toBeTruthy();
    expect(screen.getByText('Executed Oct 31, 2026')).toBeTruthy();
  });

  it('displays prominent truthfulness notice separating integration proof from 917-payee demo batch', () => {
    render(<RecentPayPalExecutionCard />);

    // Critical Truthfulness Copy visible without tooltips
    const notice = screen.getByText(/Sandbox integration proof · Separate from the 917-payee demo batch/i);
    expect(notice).toBeTruthy();

    // Explanation clarifying Ready Batch #1 and 17 exceptions are offline models
    expect(screen.getByText(/Ready Batch #1 \(\$140,594\.47\) and 17 exceptions are offline demonstration models/i)).toBeTruthy();
  });

  it('toggles optional reconciliation details panel with item-level transactions and fees', () => {
    render(<RecentPayPalExecutionCard />);

    // Initially details panel is collapsed
    expect(screen.queryByTestId('paypal-proof-details')).toBeNull();

    // Click toggle button
    const toggleBtn = screen.getByTestId('toggle-paypal-details');
    expect(toggleBtn.textContent).toContain('View reconciliation details');
    fireEvent.click(toggleBtn);

    // Details panel is now visible
    const detailsPanel = screen.getByTestId('paypal-proof-details');
    expect(detailsPanel).toBeTruthy();
    expect(toggleBtn.textContent).toContain('Hide reconciliation details');

    // Details verification
    expect(screen.getByText('Batch Status')).toBeTruthy();
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('0 / 0')).toBeTruthy();
    expect(screen.getByText('Total PayPal Fees')).toBeTruthy();
    expect(screen.getByText('$0.04 USD')).toBeTruthy();

    // Transactions breakdown (2 items of $1.00 each)
    expect(screen.getByText(/Payout Item #1 \(Item ID: W657YPKBPFFEY\)/i)).toBeTruthy();
    expect(screen.getByText(/PayPal Tx: 7CK89601G2473524M · Fee: \$0\.02 USD/i)).toBeTruthy();
    expect(screen.getByText(/Payout Item #2 \(Item ID: 8GSHQ3PEZLWAL\)/i)).toBeTruthy();
    expect(screen.getByText(/PayPal Tx: 2H839828DF5533320 · Fee: \$0\.02 USD/i)).toBeTruthy();

    // Click again to collapse
    fireEvent.click(toggleBtn);
    expect(screen.queryByTestId('paypal-proof-details')).toBeNull();
  });

  it('guarantees zero exposure of recipient email addresses, access tokens, or client credentials', () => {
    const { container } = render(<RecentPayPalExecutionCard />);

    const html = container.innerHTML;
    // Recipient emails must never be displayed
    expect(html).not.toContain('personal.example.com');
    expect(html).not.toContain('sb-');
    expect(html).not.toContain('bearer');
    expect(html).not.toContain('client_secret');
    expect(html).not.toContain('Basic ');
  });
});
