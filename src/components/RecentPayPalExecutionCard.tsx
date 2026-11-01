"use client";

import React, { useState } from 'react';
import styles from '../app/page.module.css';

/**
 * PAYOUT-07: Judge-Facing PayPal Execution & Reconciliation Proof Component
 *
 * Displays the verified PAYOUT-06 PayPal Sandbox execution and reconciliation:
 * - PayPal Payout Batch ID: H6YTQ7QCBF4RU
 * - Sender Batch ID: ACTOVRA-PROOF-1793472667529-Z3YF32
 * - Total: $2.00 USD (2 items of $1.00 USD each)
 * - Status: SUCCESS (Reconciled with PayPal)
 * - 2 completed · 0 pending · 0 failed
 * - Strict truthfulness: Clearly identified as Sandbox integration proof,
 *   separate from the 917-payee demo batch.
 * - Zero secrets, bearer tokens, or recipient emails exposed.
 */

export interface RecentPayPalExecutionCardProps {
  readonly className?: string;
}

export function RecentPayPalExecutionCard({ className }: RecentPayPalExecutionCardProps): React.JSX.Element {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      className={`${styles.contentCard} ${className ?? ''}`}
      data-testid="recent-paypal-execution"
    >
      {/* Header with Title and Proof Badges */}
      <div className={styles.contentCardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <h3 className={styles.contentCardTitle}>Recent PayPal Execution</h3>
          <span className={styles.paypalProofBadge}>SANDBOX · INTEGRATION PROOF</span>
        </div>
        <span className={`${styles.populationPill} ${styles.pillReady}`}>✓ SUCCESS</span>
      </div>

      {/* Primary Financial Stats Row */}
      <div className={styles.paypalProofStatsRow}>
        <div className={styles.paypalProofPrimary}>
          <span className={styles.paypalProofAmount}>$2.00 USD</span>
          <span className={styles.paypalProofRecipients}>2 payout items</span>
        </div>

        <div className={styles.paypalProofReconSummary}>
          <span className={styles.paypalProofSummaryItemSuccess}>✓ 2 completed</span>
          <span className={styles.paypalProofSummaryDivider}>·</span>
          <span className={styles.paypalProofSummaryItemNeutral}>0 pending</span>
          <span className={styles.paypalProofSummaryDivider}>·</span>
          <span className={styles.paypalProofSummaryItemNeutral}>0 failed</span>
        </div>
      </div>

      {/* Batch Reference & Reconciliation Status */}
      <div className={styles.paypalProofMetaRow}>
        <div className={styles.paypalProofMetaLeft}>
          <span className={styles.paypalProofMetaLabel}>PayPal Batch</span>
          <span className={styles.paypalProofBatchId}>H6YTQ7QCBF4RU</span>
          <span className={styles.paypalProofReconciledCopy}>✓ Reconciled with PayPal</span>
        </div>
        <div className={styles.paypalProofMetaRight}>
          <span className={styles.paypalProofDate}>Executed Oct 31, 2026</span>
        </div>
      </div>

      {/* Critical Truthfulness Notice: Visible without opening tooltips */}
      <div className={styles.paypalTruthfulnessNotice}>
        <span className={styles.paypalTruthfulnessIcon} aria-hidden="true">ℹ</span>
        <div>
          <strong>Sandbox integration proof · Separate from the 917-payee demo batch</strong>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            Proves live multi-item PayPal Sandbox Payouts API settlement and item-level reconciliation.
            Ready Batch #1 ($140,594.47) and 17 exceptions are offline demonstration models.
          </div>
        </div>
      </div>

      {/* Optional Reconciliation Details Panel */}
      <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
        <button
          type="button"
          className={styles.paypalDetailsToggle}
          onClick={() => setShowDetails((prev) => !prev)}
          aria-expanded={showDetails}
          data-testid="toggle-paypal-details"
        >
          {showDetails ? 'Hide reconciliation details ▲' : 'View reconciliation details ▼'}
        </button>

        {showDetails && (
          <div className={styles.paypalDetailsPanel} data-testid="paypal-proof-details">
            <div className={styles.paypalDetailsGrid}>
              <div className={styles.paypalDetailItem}>
                <span className={styles.paypalDetailLabel}>Batch Status</span>
                <span className={styles.paypalDetailValue}>SUCCESS</span>
              </div>
              <div className={styles.paypalDetailItem}>
                <span className={styles.paypalDetailLabel}>Requested / Completed</span>
                <span className={styles.paypalDetailValue}>2 / 2</span>
              </div>
              <div className={styles.paypalDetailItem}>
                <span className={styles.paypalDetailLabel}>Pending / Failed</span>
                <span className={styles.paypalDetailValue}>0 / 0</span>
              </div>
              <div className={styles.paypalDetailItem}>
                <span className={styles.paypalDetailLabel}>Total PayPal Fees</span>
                <span className={styles.paypalDetailValue}>$0.04 USD</span>
              </div>
            </div>

            <div className={styles.paypalTransactionsList}>
              <div className={styles.paypalTxRow}>
                <div className={styles.paypalTxLeft}>
                  <span className={styles.paypalTxName}>Payout Item #1 (Item ID: W657YPKBPFFEY)</span>
                  <span className={styles.paypalTxSub}>PayPal Tx: 7CK89601G2473524M · Fee: $0.02 USD</span>
                </div>
                <div className={styles.paypalTxRight}>
                  <span className={styles.paypalTxAmount}>$1.00 USD</span>
                  <span className={`${styles.populationPill} ${styles.pillReady}`}>✓ SUCCESS</span>
                </div>
              </div>

              <div className={styles.paypalTxRow}>
                <div className={styles.paypalTxLeft}>
                  <span className={styles.paypalTxName}>Payout Item #2 (Item ID: 8GSHQ3PEZLWAL)</span>
                  <span className={styles.paypalTxSub}>PayPal Tx: 2H839828DF5533320 · Fee: $0.02 USD</span>
                </div>
                <div className={styles.paypalTxRight}>
                  <span className={styles.paypalTxAmount}>$1.00 USD</span>
                  <span className={`${styles.populationPill} ${styles.pillReady}`}>✓ SUCCESS</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
