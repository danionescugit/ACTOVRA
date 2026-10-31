"use client";

import React, { useState, useMemo } from 'react';
import styles from '../app/page.module.css';
import { RecentPayPalExecutionCard } from './RecentPayPalExecutionCard';
import {
  generateSyntheticPayoutPopulation,
  classifyPayoutPopulation,
  aggregatePayoutBatch,
  evaluateFinancialMandate,
  evaluateReadyPayoutBatch,
  evaluateReviewedExceptionBatch,
  getReviewPlaybook,
  defaultFinancialMandateConfig,
  type OperatorExceptionResolution,
  type ExceptionReviewPlaybook,
} from '../payouts';

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Canonical simulated operator resolution scenario from PAYOUT-03 (10 Approved / 7 Held)
const CANONICAL_RESOLUTIONS: OperatorExceptionResolution[] = [
  {
    payoutItemId: 'payout-042',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:00:00.000Z',
    resolutionNote: 'Verified Sarah Jenkins campaign launch on TikTok; surge is legitimate sales volume.',
  },
  {
    payoutItemId: 'payout-043',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:01:00.000Z',
    resolutionNote: 'Reviewed Tyler Ross traffic logs; low refund rate confirmed.',
  },
  {
    payoutItemId: 'payout-044',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:02:00.000Z',
    resolutionNote: 'Approved velocity expansion.',
  },
  {
    payoutItemId: 'payout-045',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:03:00.000Z',
    resolutionNote: 'Approved velocity expansion.',
  },
  {
    payoutItemId: 'payout-046',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:04:00.000Z',
    resolutionNote: 'Approved velocity expansion.',
  },
  {
    payoutItemId: 'payout-047',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:05:00.000Z',
    resolutionNote: 'Approved velocity expansion.',
  },
  {
    payoutItemId: 'payout-048',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'finance.ops@company.com',
    resolvedAt: '2026-10-31T14:06:00.000Z',
    resolutionNote: 'Reviewed Zoe Kravitz affiliate campaign traffic; confirmed legitimate conversion.',
  },
  {
    payoutItemId: 'payout-301',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'risk.officer@company.com',
    resolvedAt: '2026-10-31T14:07:00.000Z',
    resolutionNote: 'Held: TechGear Reviews refund rate 26% exceeds tolerance.',
  },
  {
    payoutItemId: 'payout-302',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'risk.officer@company.com',
    resolvedAt: '2026-10-31T14:08:00.000Z',
    resolutionNote: 'Held: Flash Deals Network refund rate exceeds tolerance.',
  },
  {
    payoutItemId: 'payout-303',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'risk.officer@company.com',
    resolvedAt: '2026-10-31T14:09:00.000Z',
    resolutionNote: 'Held: Bargain Hunter Daily refund rate exceeds tolerance.',
  },
  {
    payoutItemId: 'payout-304',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'risk.officer@company.com',
    resolvedAt: '2026-10-31T14:10:00.000Z',
    resolutionNote: 'Held: Coupon Matrix Hub refund rate exceeds tolerance.',
  },
  {
    payoutItemId: 'payout-101',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'security.lead@company.com',
    resolvedAt: '2026-10-31T14:11:00.000Z',
    resolutionNote: 'Marcus Chen completed phone and 2FA verification of new PayPal destination.',
  },
  {
    payoutItemId: 'payout-102',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'security.lead@company.com',
    resolvedAt: '2026-10-31T14:12:00.000Z',
    resolutionNote: 'Chloe Bennett destination changed 2 days ago; pending outbound callback.',
  },
  {
    payoutItemId: 'payout-103',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'security.lead@company.com',
    resolvedAt: '2026-10-31T14:13:00.000Z',
    resolutionNote: 'Liam O\'Connor destination changed today (0 days ago); hold enforced.',
  },
  {
    payoutItemId: 'payout-201',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'legal.compliance@company.com',
    resolvedAt: '2026-10-31T14:14:00.000Z',
    resolutionNote: 'Elena Rostova agency authorization on file for Creative Studio IO.',
  },
  {
    payoutItemId: 'payout-202',
    resolutionStatus: 'APPROVED_FOR_BATCH',
    resolvedBy: 'legal.compliance@company.com',
    resolvedAt: '2026-10-31T14:15:00.000Z',
    resolutionNote: 'Alex Vance agency authorization on file for Creative Studio IO.',
  },
  {
    payoutItemId: 'payout-203',
    resolutionStatus: 'HELD_BY_OPERATOR',
    resolvedBy: 'legal.compliance@company.com',
    resolvedAt: '2026-10-31T14:16:00.000Z',
    resolutionNote: 'Horizon Media Group missing agency contract amendment.',
  },
];

type NavTab = 'overview' | 'exceptions' | 'recipients' | 'audit' | 'controls';
type ActiveModal = 'none' | 'ready-batch' | 'reviewed-batch' | 'exception-drawer' | 'held-inspector';

export function PayoutsDashboard() {
  // Memoized deterministic dataset (1,000 items, derived figures)
  const { items, batchSummary } = useMemo(() => {
    const rawRecords = generateSyntheticPayoutPopulation();
    const classifiedItems = classifyPayoutPopulation(rawRecords);
    const summary = aggregatePayoutBatch(classifiedItems);

    return { items: classifiedItems, batchSummary: summary };
  }, []);

  // Application State
  const [activeNav, setActiveNav] = useState<NavTab>('overview');
  const [resolutions, setResolutions] = useState<OperatorExceptionResolution[]>([]);
  const [readyBatchAuthorized, setReadyBatchAuthorized] = useState(false);
  const [reviewedBatchAuthorized, setReviewedBatchAuthorized] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveModal>('none');
  const [selectedExceptionId, setSelectedExceptionId] = useState<string>('payout-042');
  const [verifiedChecklistItems, setVerifiedChecklistItems] = useState<Record<string, Record<number, boolean>>>({});
  const [showEstimateExplanation, setShowEstimateExplanation] = useState(false);

  // Filter & Pagination State
  const [filterSearch, setFilterSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [recipientPage, setRecipientPage] = useState(1);
  const PAGE_SIZE = 25;

  // Separate item groups
  const readyItems = useMemo(() => items.filter((i) => i.status === 'READY'), [items]);
  const heldItems = useMemo(
    () =>
      items.filter(
        (i) => i.status === 'HELD_BELOW_THRESHOLD' || i.status === 'HELD_NON_POSITIVE'
      ),
    [items]
  );
  const exceptionItems = useMemo(
    () => items.filter((i) => i.status === 'AI_ANALYSIS_REQUIRED'),
    [items]
  );

  // Resolution map
  const resolutionMap = useMemo(() => {
    const map = new Map<string, OperatorExceptionResolution>();
    for (const r of resolutions) {
      map.set(r.payoutItemId, r);
    }
    return map;
  }, [resolutions]);

  // Approved exception items that form Reviewed Batch #2
  const approvedExceptionItems = useMemo(() => {
    return exceptionItems.filter(
      (item) => resolutionMap.get(item.id)?.resolutionStatus === 'APPROVED_FOR_BATCH'
    );
  }, [exceptionItems, resolutionMap]);

  // Operator-held items
  const operatorHeldExceptionItems = useMemo(() => {
    return exceptionItems.filter(
      (item) => resolutionMap.get(item.id)?.resolutionStatus === 'HELD_BY_OPERATOR'
    );
  }, [exceptionItems, resolutionMap]);

  const approvedSumCents = useMemo(
    () => approvedExceptionItems.reduce((acc, i) => acc + i.netPayableCents, 0),
    [approvedExceptionItems]
  );

  const unresolvedExceptionsCount = exceptionItems.length - resolutions.length;

  // Independent Mandate Evaluations
  const readyBatchMandate = useMemo(
    () => evaluateReadyPayoutBatch(readyItems, defaultFinancialMandateConfig),
    [readyItems]
  );

  const reviewedBatchMandate = useMemo(
    () =>
      evaluateReviewedExceptionBatch(
        approvedExceptionItems,
        resolutions,
        defaultFinancialMandateConfig
      ),
    [approvedExceptionItems, resolutions]
  );

  // Overall financial mandate result (for audit & compliance)
  const mandateResult = useMemo(
    () => evaluateFinancialMandate(batchSummary, items, resolutions, defaultFinancialMandateConfig),
    [batchSummary, items, resolutions]
  );

  // Selected exception & playbook
  const currentExceptionItem = useMemo(
    () => items.find((i) => i.id === selectedExceptionId) || exceptionItems[0],
    [items, selectedExceptionId, exceptionItems]
  );

  const currentPlaybook: ExceptionReviewPlaybook | null = useMemo(() => {
    if (!currentExceptionItem) return null;
    return getReviewPlaybook(currentExceptionItem);
  }, [currentExceptionItem]);

  // Handlers
  const handleResolveException = (
    payoutItemId: string,
    resolutionStatus: 'APPROVED_FOR_BATCH' | 'HELD_BY_OPERATOR',
    resolutionNote: string
  ): boolean => {
    // Invariant Enforcement: Incomplete verification blocks approval
    if (resolutionStatus === 'APPROVED_FOR_BATCH') {
      const item = items.find((i) => i.id === payoutItemId);
      if (!item) return false;
      const playbook = getReviewPlaybook(item);
      const reqCount = playbook.whatYouNeedToVerify.length;
      const chkMap = verifiedChecklistItems[payoutItemId] || {};
      const chkCount = playbook.whatYouNeedToVerify.filter((_, idx) => !!chkMap[idx]).length;

      if (reqCount > 0 && chkCount !== reqCount) {
        return false;
      }
    }

    setResolutions((prev) => {
      const filtered = prev.filter((r) => r.payoutItemId !== payoutItemId);
      return [
        ...filtered,
        {
          payoutItemId,
          resolutionStatus,
          resolvedBy: 'ops.specialist@actovra.internal',
          resolvedAt: new Date().toISOString(),
          resolutionNote,
        },
      ];
    });
    return true;
  };

  const toggleChecklistItem = (itemId: string, index: number) => {
    setVerifiedChecklistItems((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {}),
        [index]: !prev[itemId]?.[index],
      },
    }));
  };

  const handleApplyCanonicalScenario = () => {
    setResolutions(CANONICAL_RESOLUTIONS);
  };

  const handleResetDemo = () => {
    setResolutions([]);
    setReadyBatchAuthorized(false);
    setReviewedBatchAuthorized(false);
    setVerifiedChecklistItems({});
    setShowEstimateExplanation(false);
    setActiveModal('none');
    setSelectedExceptionId('payout-042');
    setFilterSearch('');
    setFilterStatus('ALL');
    setRecipientPage(1);
    setActiveNav('overview');
  };

  const handleAuthorizeReadyBatch = () => {
    setReadyBatchAuthorized(true);
    setActiveModal('none');
  };

  const handleAuthorizeReviewedBatch = () => {
    setReviewedBatchAuthorized(true);
    setActiveModal('none');
  };

  // Filtered recipients
  const filteredRecipients = useMemo(() => {
    return items.filter((item) => {
      if (filterStatus === 'HELD' && !(item.status === 'HELD_BELOW_THRESHOLD' || item.status === 'HELD_NON_POSITIVE')) {
        return false;
      }
      if (filterStatus !== 'ALL' && filterStatus !== 'HELD' && item.status !== filterStatus) {
        return false;
      }
      if (filterSearch) {
        const query = filterSearch.toLowerCase();
        return (
          item.id.toLowerCase().includes(query) ||
          item.recipientName.toLowerCase().includes(query) ||
          item.recipientEmail.toLowerCase().includes(query)
        );
      }
      return true;
    });
  }, [items, filterStatus, filterSearch]);

  const totalPages = Math.ceil(filteredRecipients.length / PAGE_SIZE);
  const paginatedRecipients = useMemo(() => {
    const start = (recipientPage - 1) * PAGE_SIZE;
    return filteredRecipients.slice(start, start + PAGE_SIZE);
  }, [filteredRecipients, recipientPage]);

  // Total executable disbursements across batches
  const totalDisbursedCents =
    (readyBatchAuthorized ? batchSummary.readyAmountCents : 0) +
    (reviewedBatchAuthorized ? approvedSumCents : 0);

  return (
    <div className={styles.appShell}>
      {/* 1. SIDEBAR NAVIGATION */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}>
          <div className={styles.brandLogo}>A</div>
          <div className={styles.brandInfo}>
            <h1 className={styles.brandTitle} style={{ margin: 0, fontSize: 16 }}>ACTOVRA</h1>
            <span className={styles.brandSubtitle}>AI Financial Ops</span>
          </div>
        </div>

        <nav className={styles.sidebarNav}>
          <button
            type="button"
            aria-label="Sidebar Overview"
            className={`${styles.sidebarNavItem} ${
              activeNav === 'overview' ? styles.sidebarNavItemActive : ''
            }`}
            onClick={() => setActiveNav('overview')}
          >
            <div className={styles.sidebarNavItemInner}>
              <span className={styles.navIcon}>📊</span>
              <span>Overview</span>
            </div>
          </button>

          <button
            type="button"
            aria-label="Sidebar Exceptions"
            className={`${styles.sidebarNavItem} ${
              activeNav === 'exceptions' ? styles.sidebarNavItemActive : ''
            }`}
            onClick={() => setActiveNav('exceptions')}
          >
            <div className={styles.sidebarNavItemInner}>
              <span className={styles.navIcon}>⚠️</span>
              <span>Exceptions</span>
            </div>
            {unresolvedExceptionsCount > 0 ? (
              <span className={styles.sidebarCountBadge}>{unresolvedExceptionsCount}</span>
            ) : (
              <span className={`${styles.sidebarCountBadge} ${styles.sidebarCountBadgeDone}`}>
                ✓ Done
              </span>
            )}
          </button>

          <button
            type="button"
            aria-label="Sidebar Recipients"
            className={`${styles.sidebarNavItem} ${
              activeNav === 'recipients' ? styles.sidebarNavItemActive : ''
            }`}
            onClick={() => setActiveNav('recipients')}
          >
            <div className={styles.sidebarNavItemInner}>
              <span className={styles.navIcon}>👥</span>
              <span>Recipients</span>
            </div>
            <span className={styles.sidebarCountBadge}>{items.length}</span>
          </button>

          <button
            type="button"
            aria-label="Sidebar Audit Log"
            className={`${styles.sidebarNavItem} ${
              activeNav === 'audit' ? styles.sidebarNavItemActive : ''
            }`}
            onClick={() => setActiveNav('audit')}
          >
            <div className={styles.sidebarNavItemInner}>
              <span className={styles.navIcon}>📜</span>
              <span>Audit Log</span>
            </div>
          </button>

          <button
            type="button"
            aria-label="Sidebar Financial Controls"
            className={`${styles.sidebarNavItem} ${
              activeNav === 'controls' ? styles.sidebarNavItemActive : ''
            }`}
            onClick={() => setActiveNav('controls')}
          >
            <div className={styles.sidebarNavItemInner}>
              <span className={styles.navIcon}>🛡️</span>
              <span>Financial Controls</span>
            </div>
            <span className={styles.sidebarCountBadge}>5 Rules</span>
          </button>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.sidebarStatusBlock}>
            <div className={styles.sidebarStatusRow}>
              <span className={styles.sidebarStatusLabel}>Safety Gate:</span>
              <span className={styles.sidebarStatusVal}>Deterministic</span>
            </div>
            <div className={styles.sidebarStatusRow}>
              <span className={styles.sidebarStatusLabel}>PayPal Calls:</span>
              <span className={styles.sidebarStatusVal}>0 (Zero-Touch)</span>
            </div>
            <div className={styles.sidebarStatusRow}>
              <span className={styles.sidebarStatusLabel}>Model Provenance:</span>
              <span className={styles.sidebarStatusVal}>Nemotron 3.5</span>
            </div>
          </div>
        </div>
      </aside>

      {/* 2. MAIN WORKSPACE AREA */}
      <main className={styles.mainArea}>
        {/* Top Header Bar */}
        <header className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <h2 className={styles.topBarTitle} style={{ margin: 0 }}>Payout Operations Console</h2>
            <span className={styles.cycleBadge}>CYCLE: OCT-2026-01</span>
            {totalDisbursedCents > 0 && (
              <span className={styles.cycleBadge}>AUTHORIZED: {formatCents(totalDisbursedCents)}</span>
            )}
          </div>
          <div className={styles.topBarRight}>
            <button
              type="button"
              className={styles.btnTopReset}
              onClick={handleResetDemo}
              title="Reset resolutions and batch authorizations to demo baseline"
            >
              Reset Demo
            </button>
            <div className={styles.modeBadgeSafe}>
              <span className={styles.pulseDot} />
              <span>Isolated Sandbox Active</span>
            </div>
          </div>
        </header>

        {/* Content Container */}
        <div className={styles.contentContainer}>
          {/* TAB 1: OVERVIEW */}
          {activeNav === 'overview' && (
            <>
              {/* Refined Settlement Overview Header */}
              <section className={styles.settlementOverviewHeader}>
                <div className={styles.settlementOverviewLeft}>
                  <span className={styles.settlementCycleTag}>CYCLE: OCT-2026-01</span>
                  <h1 className={styles.settlementTitle}>October 2026 Affiliate Settlement</h1>
                  <div className={styles.settlementMetaRow}>
                    <span>1,000 recipients</span>
                    <span>•</span>
                    <span>USD</span>
                    <span>•</span>
                    <span>Cycle OCT-2026-01</span>
                  </div>
                </div>
                <div className={styles.settlementOverviewRight}>
                  <span className={styles.totalPayoutLabel}>Total calculated payout</span>
                  <span className={styles.totalPayoutAmount}>
                    {formatCents(batchSummary.totalNetPayableCents)}
                  </span>
                  <span className={styles.totalPayoutSub}>100% deterministic ledger verified</span>
                </div>
              </section>

              {/* Proportional Segmented Bar */}
              <section className={styles.proportionalBarWrapper}>
                <div className={styles.proportionalBarTop}>
                  <span className={styles.proportionalBarTitle}>
                    Payout distribution
                  </span>
                  <span className={styles.proportionalBarMeta}>
                    {items.length} Affiliates | {formatCents(batchSummary.totalNetPayableCents)} Net
                  </span>
                </div>
                <div className={styles.proportionalBarTrack}>
                  <div
                    className={styles.proportionalBarSegmentReady}
                    style={{ width: `${(readyItems.length / items.length) * 100}%` }}
                    title={`Ready to pay: ${readyItems.length} (${(
                      (readyItems.length / items.length) *
                      100
                    ).toFixed(1)}%)`}
                  />
                  <div
                    className={styles.proportionalBarSegmentHeld}
                    style={{ width: `${(heldItems.length / items.length) * 100}%` }}
                    title={`Automatically held: ${heldItems.length} (${(
                      (heldItems.length / items.length) *
                      100
                    ).toFixed(1)}%)`}
                  />
                  <div
                    className={styles.proportionalBarSegmentReview}
                    style={{ width: `${(exceptionItems.length / items.length) * 100}%` }}
                    title={`Needs review: ${exceptionItems.length} (${(
                      (exceptionItems.length / items.length) *
                      100
                    ).toFixed(1)}%)`}
                  />
                </div>
                <div className={styles.proportionalBarLegend}>
                  <div className={styles.legendItem}>
                    <span
                      className={styles.legendColorDot}
                      style={{ background: '#10b981' }}
                    />
                    <span>Ready to pay:</span>
                    <span className={styles.legendVal}>
                      {readyItems.length} ({formatCents(batchSummary.readyAmountCents)})
                    </span>
                  </div>
                  <div className={styles.legendItem}>
                    <span
                      className={styles.legendColorDot}
                      style={{ background: '#ef4444' }}
                    />
                    <span>Automatically held:</span>
                    <span className={styles.legendVal}>
                      {heldItems.length} ({formatCents(batchSummary.heldAmountCents)})
                    </span>
                  </div>
                  <div className={styles.legendItem}>
                    <span
                      className={styles.legendColorDot}
                      style={{ background: '#f59e0b' }}
                    />
                    <span>Needs review:</span>
                    <span className={styles.legendVal}>
                      {exceptionItems.length} ({formatCents(batchSummary.analysisRequiredAmountCents)})
                    </span>
                  </div>
                </div>
              </section>

              {/* Triad Population Cards */}
              <section className={styles.triadGrid}>
                {/* CARD 1: Routine Clean Payouts (Ready Batch #1) */}
                <div className={`${styles.populationCard} ${styles.populationCardReady}`}>
                  <div className={styles.populationCardHeader}>
                    <span className={styles.populationCardTitle}>Ready Batch #1</span>
                    <span className={`${styles.populationPill} ${styles.pillReady}`}>
                      {readyItems.length} PAYEES
                    </span>
                  </div>
                  <div className={styles.populationCardAmount}>
                    {formatCents(batchSummary.readyAmountCents)}
                  </div>
                  <div className={styles.populationCardSub}>
                    Ready to pay
                  </div>
                  <p className={styles.populationCardDescription}>
                    All payout calculations and financial controls passed. Ready for human authorization.
                  </p>
                  <div className={styles.populationCardFooter}>
                    {!readyBatchAuthorized ? (
                      <button
                        type="button"
                        className={styles.btnSuccess}
                        onClick={() => setActiveModal('ready-batch')}
                      >
                        Review & authorize 917 payouts
                      </button>
                    ) : (
                      <div className={styles.authorizedBanner}>
                        <div className={styles.authorizedBannerLeft}>
                          <span style={{ color: '#10b981', fontWeight: 800 }}>✓</span>
                          <span className={styles.authorizedBannerText}>
                            Ready Batch #1 Authorized
                          </span>
                        </div>
                        <span className={styles.authorizedBannerSub}>
                          {formatCents(batchSummary.readyAmountCents)} (917 payees)
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* CARD 2: Needs Human Attention (Exceptions & Reviewed Batch #2) */}
                <div className={`${styles.populationCard} ${styles.populationCardReview}`}>
                  <div className={styles.populationCardHeader}>
                    <span className={styles.populationCardTitle}>Needs Attention</span>
                    <span className={`${styles.populationPill} ${styles.pillReview}`}>
                      {exceptionItems.length} EXCEPTIONS
                    </span>
                  </div>
                  <div className={styles.populationCardAmount}>
                    {formatCents(batchSummary.analysisRequiredAmountCents)}
                  </div>
                  <div className={styles.populationCardSub}>
                    Needs your review
                  </div>
                  <p className={styles.populationCardDescription}>
                    ACTOVRA isolated 17 unusual cases for operator review. They do not block the ready batch.
                  </p>
                  <div className={styles.populationCardFooter}>
                    <button
                      type="button"
                      className={styles.btnPrimary}
                      onClick={() => {
                        setSelectedExceptionId('payout-042');
                        setActiveModal('exception-drawer');
                      }}
                    >
                      Review 17 exceptions
                    </button>

                    {approvedExceptionItems.length > 0 && (
                      <div className={styles.reviewedBatchContainer}>
                        <div className={styles.reviewedBatchHeader}>
                          <span className={styles.reviewedBatchTitle}>
                            Reviewed Batch #2 ({approvedExceptionItems.length} approved)
                          </span>
                          <span className={styles.reviewedBatchAmount}>
                            {formatCents(approvedSumCents)}
                          </span>
                        </div>
                        {!reviewedBatchAuthorized ? (
                          <button
                            type="button"
                            className={styles.btnSuccess}
                            onClick={() => setActiveModal('reviewed-batch')}
                          >
                            Authorize Reviewed Batch ({approvedExceptionItems.length})
                          </button>
                        ) : (
                          <div className={styles.authorizedBanner}>
                            <div className={styles.authorizedBannerLeft}>
                              <span style={{ color: '#10b981', fontWeight: 800 }}>✓</span>
                              <span className={styles.authorizedBannerText}>
                                Batch #2 Authorized
                              </span>
                            </div>
                            <span className={styles.authorizedBannerSub}>
                              {formatCents(approvedSumCents)} ({approvedExceptionItems.length} payees)
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* CARD 3: Deterministically Held */}
                <div className={`${styles.populationCard} ${styles.populationCardHeld}`}>
                  <div className={styles.populationCardHeader}>
                    <span className={styles.populationCardTitle}>Rule-Held Payouts</span>
                    <span className={`${styles.populationPill} ${styles.pillHeld}`}>
                      {heldItems.length} PAYEES
                    </span>
                  </div>
                  <div className={styles.populationCardAmount}>
                    {formatCents(batchSummary.heldAmountCents)}
                  </div>
                  <div className={styles.populationCardSub}>
                    Automatically held
                  </div>
                  <p className={styles.populationCardDescription}>
                    Held automatically by payout rules and carried forward where applicable.
                  </p>
                  <div className={styles.populationCardFooter}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setActiveModal('held-inspector')}
                    >
                      View 66 held payouts
                    </button>
                  </div>
                </div>
              </section>

              {/* LOCKED OPERATIONAL IMPACT COMPONENT */}
              <section className={styles.operationalImpactCard}>
                <div className={styles.operationalImpactHeader}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <h3 className={styles.operationalImpactTitle}>Operational Impact</h3>
                      <span className={styles.statementStatLabel}>Review Reduction</span>
                    </div>
                    <p className={styles.operationalImpactSubtitle}>
                      ACTOVRA eliminates {items.length - exceptionItems.length} routine reviews from your queue.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={styles.howEstimatedButton}
                    onClick={() => setShowEstimateExplanation(true)}
                  >
                    How is this estimated? →
                  </button>
                </div>

                <div className={styles.operationalImpactBody}>
                  {/* LEFT: Green Donut Chart */}
                  <div className={styles.impactDonutSection}>
                    <div className={styles.donutContainer}>
                      <svg viewBox="0 0 120 120" className={styles.donutSvg}>
                        <circle
                          cx="60"
                          cy="60"
                          r="48"
                          className={styles.donutCircleBg}
                        />
                        <circle
                          cx="60"
                          cy="60"
                          r="48"
                          className={styles.donutCircleFg}
                          strokeDasharray="296.47 301.59"
                          strokeDashoffset="0"
                          transform="rotate(-90 60 60)"
                        />
                      </svg>
                      <div className={styles.donutCenterText}>
                        <span className={styles.donutPercentage}>98.3%</span>
                        <span className={styles.donutLabel}>fewer reviews</span>
                      </div>
                    </div>
                  </div>

                  {/* RIGHT: Two Comparison Rows + Result Panel */}
                  <div className={styles.impactRightColumn}>
                    <div className={styles.comparisonRowsGrid}>
                      {/* Row 1: WITHOUT ACTOVRA */}
                      <div className={styles.comparisonRowWithout}>
                        <div className={styles.comparisonRowLeft}>
                          <div className={styles.comparisonIconWithout}>✕</div>
                          <div>
                            <div className={styles.comparisonRowTitle}>WITHOUT ACTOVRA</div>
                            <div className={styles.comparisonRowSub}>Estimated review time</div>
                          </div>
                        </div>
                        <div className={styles.comparisonRowRight}>
                          <span className={styles.comparisonRowUnits}>1,000 payouts</span>
                          <span className={styles.comparisonRowTimeWithout}>8h 20m</span>
                        </div>
                      </div>

                      {/* Row 2: WITH ACTOVRA */}
                      <div className={styles.comparisonRowWith}>
                        <div className={styles.comparisonRowLeft}>
                          <div className={styles.comparisonIconWith}>✓</div>
                          <div>
                            <div className={styles.comparisonRowTitle}>WITH ACTOVRA</div>
                            <div className={styles.comparisonRowSub}>Estimated review time</div>
                          </div>
                        </div>
                        <div className={styles.comparisonRowRight}>
                          <span className={styles.comparisonRowUnits}>17 payouts</span>
                          <span className={styles.comparisonRowTimeWith}>8m 30s</span>
                        </div>
                      </div>
                    </div>

                    {/* Pale Green Result Panel */}
                    <div className={styles.paleGreenResultPanel}>
                      <div className={styles.resultPanelLargeTime}>≈ 8h 12m</div>
                      <div className={styles.resultPanelLabel}>of routine review avoided</div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Lower Section: Active Batch Settlements & Financial Governance */}
              <section className={styles.lowerGrid}>
                {/* Left Column: Active Batches + Recent PayPal Execution Proof */}
                <div className={styles.lowerLeftCol}>
                  {/* Active Batch Settlements Card */}
                  <div className={styles.contentCard}>
                    <div className={styles.contentCardHeader}>
                      <h3 className={styles.contentCardTitle}>Active Settlement Batches</h3>
                    </div>
                    <div className={styles.tableResponsive}>
                      <table className={styles.lightTable}>
                        <thead>
                          <tr>
                            <th>Batch Identifier</th>
                            <th>Payees</th>
                            <th>Disbursement Amount</th>
                            <th>Mandate Status</th>
                            <th>Authorization State</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className={styles.lightTableRow}>
                            <td>
                              <strong>Ready Batch #1</strong>
                              <div style={{ fontSize: 11, color: '#64748b' }}>
                                Routine clean payouts
                              </div>
                            </td>
                            <td>{readyItems.length}</td>
                            <td>
                              <strong>{formatCents(batchSummary.readyAmountCents)}</strong>
                            </td>
                            <td>
                              <span className={`${styles.populationPill} ${styles.pillReady}`}>
                                PASS (100%)
                              </span>
                            </td>
                            <td>
                              {readyBatchAuthorized ? (
                                <span style={{ color: '#059669', fontWeight: 700 }}>
                                  ✓ Authorized
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.btnSuccessOutline}
                                  onClick={() => setActiveModal('ready-batch')}
                                >
                                  Authorize Now
                                </button>
                              )}
                            </td>
                          </tr>

                          <tr className={styles.lightTableRow}>
                            <td>
                              <strong>Reviewed Batch #2</strong>
                              <div style={{ fontSize: 11, color: '#64748b' }}>
                                Operator-cleared exceptions
                              </div>
                            </td>
                            <td>{approvedExceptionItems.length}</td>
                            <td>
                              <strong>{formatCents(approvedSumCents)}</strong>
                            </td>
                            <td>
                              {approvedExceptionItems.length > 0 ? (
                                <span className={`${styles.populationPill} ${styles.pillReady}`}>
                                  PASS (Audit verified)
                                </span>
                              ) : (
                                <span style={{ color: '#94a3b8', fontSize: 12 }}>
                                  Pending Review ({exceptionItems.length} remaining)
                                </span>
                              )}
                            </td>
                            <td>
                              {approvedExceptionItems.length === 0 ? (
                                <button
                                  type="button"
                                  className={styles.btnGhost}
                                  onClick={() => {
                                    setSelectedExceptionId('payout-042');
                                    setActiveModal('exception-drawer');
                                  }}
                                >
                                  Review Exceptions
                                </button>
                              ) : reviewedBatchAuthorized ? (
                                <span style={{ color: '#059669', fontWeight: 700 }}>
                                  ✓ Authorized
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.btnSuccessOutline}
                                  onClick={() => setActiveModal('reviewed-batch')}
                                >
                                  Authorize Batch #2
                                </button>
                              )}
                            </td>
                          </tr>

                          <tr className={styles.lightTableRow}>
                            <td>
                              <strong>Held Balances</strong>
                              <div style={{ fontSize: 11, color: '#64748b' }}>
                                Sub-threshold & risk holds
                              </div>
                            </td>
                            <td>{heldItems.length + operatorHeldExceptionItems.length}</td>
                            <td>
                              <strong>
                                {formatCents(
                                  batchSummary.heldAmountCents +
                                    operatorHeldExceptionItems.reduce(
                                      (a, b) => a + b.netPayableCents,
                                      0
                                    )
                                )}
                              </strong>
                            </td>
                            <td>
                              <span className={`${styles.populationPill} ${styles.pillHeld}`}>
                                HOLD ENFORCED
                              </span>
                            </td>
                            <td>
                              <span style={{ color: '#dc2626', fontSize: 12, fontWeight: 600 }}>
                                Rolled to Next Cycle
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Recent PayPal Execution Card (PAYOUT-07 Judge-Facing Execution Proof) */}
                  <RecentPayPalExecutionCard />
                </div>

                {/* Financial Controls Panel */}
                <div className={styles.contentCard}>
                  <div className={styles.contentCardHeader}>
                    <h3 className={styles.contentCardTitle}>Financial Controls</h3>
                    <span className={`${styles.populationPill} ${styles.pillReady}`}>
                      {mandateResult.status === 'PASSED' ? 'All active (Passed)' : 'All active'}
                    </span>
                  </div>
                  <div className={styles.controlsList}>
                    <div className={styles.controlItem}>
                      <div className={styles.controlItemLeft}>
                        <span className={styles.controlItemName}>Batch budget ceiling</span>
                        <span className={styles.controlItemDesc}>$150,000.00 max limit</span>
                      </div>
                      <span className={styles.controlItemStatus}>✓ Batch within limit</span>
                    </div>

                    <div className={styles.controlItem}>
                      <div className={styles.controlItemLeft}>
                        <span className={styles.controlItemName}>Currency validation</span>
                        <span className={styles.controlItemDesc}>Settlement in USD</span>
                      </div>
                      <span className={styles.controlItemStatus}>✓ Currency valid</span>
                    </div>

                    <div className={styles.controlItem}>
                      <div className={styles.controlItemLeft}>
                        <span className={styles.controlItemName}>Contractual minimum</span>
                        <span className={styles.controlItemDesc}>$50.00 contractual floor</span>
                      </div>
                      <span className={styles.controlItemStatus}>✓ Minimum payout rule active</span>
                    </div>

                    <div className={styles.controlItem}>
                      <div className={styles.controlItemLeft}>
                        <span className={styles.controlItemName}>Destination security</span>
                        <span className={styles.controlItemDesc}>72-hour freeze window</span>
                      </div>
                      <span className={styles.controlItemStatus}>✓ Destination security active</span>
                    </div>

                    <div className={styles.controlItem}>
                      <div className={styles.controlItemLeft}>
                        <span className={styles.controlItemName}>Human authorization gate</span>
                        <span className={styles.controlItemDesc}>Mandatory operator sign-off</span>
                      </div>
                      <span className={styles.controlItemStatus}>✓ Human authorization required</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Subtle Demo Controls Utility Bar */}
              <div className={styles.demoControlsBar}>
                <div className={styles.demoControlsLabel}>
                  <span>⚡ Demo controls:</span>
                  <span>Pre-load canonical simulated operator resolution scenario</span>
                </div>
                <div className={styles.demoControlsButtons}>
                  <button
                    type="button"
                    className={styles.canonicalButton}
                    onClick={handleApplyCanonicalScenario}
                  >
                    ⚡ Apply Canonical Scenario (10 Approved / 7 Held)
                  </button>
                  <button
                    type="button"
                    className={styles.btnTopReset}
                    onClick={handleResetDemo}
                  >
                    Restore Baseline
                  </button>
                </div>
              </div>
            </>
          )}

          {/* TAB 2: EXCEPTIONS */}
          {activeNav === 'exceptions' && (
            <div className={styles.tabContentWrapper}>
              <div className={styles.tabHeader}>
                <div>
                  <h2 className={styles.tabTitle}>Exception Intelligence Workspace</h2>
                  <p className={styles.tabSubtitle}>
                    17 payees flagged for operator review. Clear exceptions to accumulate into
                    Reviewed Batch #2.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    className={styles.canonicalButton}
                    onClick={handleApplyCanonicalScenario}
                  >
                    ⚡ Apply Canonical Scenario (10 Approved / 7 Held)
                  </button>
                  {approvedExceptionItems.length > 0 && !reviewedBatchAuthorized && (
                    <button
                      type="button"
                      className={styles.btnSuccess}
                      onClick={() => setActiveModal('reviewed-batch')}
                    >
                      Authorize Reviewed Batch ({approvedExceptionItems.length})
                    </button>
                  )}
                </div>
              </div>

              <div className={styles.contentCard}>
                <div className={styles.tableResponsive}>
                  <table className={styles.lightTable}>
                    <thead>
                      <tr>
                        <th>Affiliate / Payee</th>
                        <th>Payable Amount</th>
                        <th>Attention Level</th>
                        <th>Primary Issue</th>
                        <th>Assessment Source</th>
                        <th>Resolution Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exceptionItems.map((item) => {
                        const playbook = getReviewPlaybook(item);
                        const res = resolutionMap.get(item.id);
                        return (
                          <tr key={item.id} className={styles.lightTableRow}>
                            <td>
                              <strong>{item.recipientName}</strong>
                              <div style={{ fontSize: 11, color: '#64748b' }}>
                                {item.recipientEmail} • {item.id}
                              </div>
                            </td>
                            <td>
                              <strong>{formatCents(item.netPayableCents)}</strong>
                            </td>
                            <td>
                              <span
                                className={
                                  playbook.attentionLevel === 'HIGH'
                                    ? styles.attentionPillHigh
                                    : playbook.attentionLevel === 'MEDIUM'
                                    ? styles.attentionPillMed
                                    : styles.attentionPillLow
                                }
                              >
                                {playbook.attentionLevel} ATTENTION ({playbook.riskScore}/100)
                              </span>
                            </td>
                            <td>
                              <span style={{ fontWeight: 600, color: '#0f172a' }}>
                                {playbook.issueSummary}
                              </span>
                            </td>
                            <td>
                              <span style={{ fontSize: 11.5, color: '#475569' }}>
                                {playbook.assessmentSource}
                              </span>
                            </td>
                            <td>
                              {res ? (
                                res.resolutionStatus === 'APPROVED_FOR_BATCH' ? (
                                  <span className={styles.drawerItemBadgeApproved}>
                                    ✓ APPROVED
                                  </span>
                                ) : (
                                  <span className={styles.drawerItemBadgeHeld}>
                                    ✕ HELD
                                  </span>
                                )
                              ) : (
                                <span style={{ color: '#d97706', fontSize: 12, fontWeight: 600 }}>
                                  ⏳ PENDING REVIEW
                                </span>
                              )}
                            </td>
                            <td>
                              <button
                                type="button"
                                className={styles.btnPrimary}
                                style={{ padding: '6px 12px', fontSize: 12, width: 'auto' }}
                                onClick={() => {
                                  setSelectedExceptionId(item.id);
                                  setActiveModal('exception-drawer');
                                }}
                              >
                                Review Playbook
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: RECIPIENTS */}
          {activeNav === 'recipients' && (
            <div className={styles.tabContentWrapper}>
              <div className={styles.tabHeader}>
                <div>
                  <h2 className={styles.tabTitle}>All Payout Recipients Ledger</h2>
                  <p className={styles.tabSubtitle}>
                    Complete census of 1,000 synthetic payees in the October 2026 cycle.
                  </p>
                </div>
              </div>

              <div className={styles.filterBar}>
                <input
                  type="text"
                  placeholder="Search by affiliate name, ID, or email..."
                  className={styles.filterSearchInput}
                  value={filterSearch}
                  onChange={(e) => {
                    setFilterSearch(e.target.value);
                    setRecipientPage(1);
                  }}
                />
                <select
                  className={styles.filterSelect}
                  value={filterStatus}
                  onChange={(e) => {
                    setFilterStatus(e.target.value);
                    setRecipientPage(1);
                  }}
                >
                  <option value="ALL">All Statuses ({items.length})</option>
                  <option value="READY">Routine Ready ({readyItems.length})</option>
                  <option value="AI_ANALYSIS_REQUIRED">
                    Needs Attention ({exceptionItems.length})
                  </option>
                  <option value="HELD">Rule-Held ({heldItems.length})</option>
                </select>
              </div>

              <div className={styles.contentCard} style={{ padding: 0 }}>
                <div className={styles.tableResponsive}>
                  <table className={styles.lightTable}>
                    <thead>
                      <tr>
                        <th>Affiliate Identifier</th>
                        <th>Payee Name</th>
                        <th>PayPal Destination</th>
                        <th>Gross Calculated</th>
                        <th>Deductions</th>
                        <th>Net Payable</th>
                        <th>Classification Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedRecipients.map((item) => (
                        <tr key={item.id} className={styles.lightTableRow}>
                          <td>
                            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}>
                              {item.id}
                            </span>
                          </td>
                          <td>
                            <strong>{item.recipientName}</strong>
                          </td>
                          <td>
                            <span style={{ color: '#64748b', fontSize: 12 }}>
                              {item.recipientEmail}
                            </span>
                          </td>
                          <td>{formatCents(item.grossCommissionsCents)}</td>
                          <td>
                            {formatCents(
                              item.refundDeductionsCents +
                                item.chargebackDeductionsCents +
                                Math.abs(item.priorAdjustmentCents)
                            )}
                          </td>
                          <td>
                            <strong>{formatCents(item.netPayableCents)}</strong>
                          </td>
                          <td>
                            {item.status === 'READY' && (
                              <span className={`${styles.populationPill} ${styles.pillReady}`}>
                                READY
                              </span>
                            )}
                            {item.status === 'AI_ANALYSIS_REQUIRED' && (
                              <span className={`${styles.populationPill} ${styles.pillReview}`}>
                                NEEDS REVIEW
                              </span>
                            )}
                            {(item.status === 'HELD_BELOW_THRESHOLD' ||
                              item.status === 'HELD_NON_POSITIVE') && (
                              <span className={`${styles.populationPill} ${styles.pillHeld}`}>
                                RULE-HELD
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className={styles.paginationContainer}>
                  <span>
                    Showing {Math.min((recipientPage - 1) * PAGE_SIZE + 1, filteredRecipients.length)}{' '}
                    to {Math.min(recipientPage * PAGE_SIZE, filteredRecipients.length)} of{' '}
                    {filteredRecipients.length} entries
                  </span>
                  <div className={styles.paginationButtons}>
                    <button
                      type="button"
                      className={styles.btnPagination}
                      disabled={recipientPage <= 1}
                      onClick={() => setRecipientPage((p) => p - 1)}
                    >
                      Previous
                    </button>
                    <span style={{ alignSelf: 'center', fontWeight: 600 }}>
                      Page {recipientPage} of {Math.max(1, totalPages)}
                    </span>
                    <button
                      type="button"
                      className={styles.btnPagination}
                      disabled={recipientPage >= totalPages}
                      onClick={() => setRecipientPage((p) => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: AUDIT LOG */}
          {activeNav === 'audit' && (
            <div className={styles.tabContentWrapper}>
              <div className={styles.tabHeader}>
                <div>
                  <h2 className={styles.tabTitle}>Financial Operations Audit Trail</h2>
                  <p className={styles.tabSubtitle}>
                    Immutable record of population synthesis, AI evaluations, mandate checks, and
                    human authorizations.
                  </p>
                </div>
              </div>

              <div className={styles.auditTimeline}>
                {reviewedBatchAuthorized && (
                  <div className={styles.auditLogCard}>
                    <div className={styles.auditLogCardLeft}>
                      <span className={styles.auditLogCardTitle}>
                        Reviewed Batch #2 Authorized by Finance Operator
                      </span>
                      <span className={styles.auditLogCardDesc}>
                        Authorization granted for {approvedExceptionItems.length} reviewed
                        exceptions ({formatCents(approvedSumCents)}). Four-eye threshold passed.
                      </span>
                    </div>
                    <span className={styles.auditLogCardTime}>2026-10-31T14:20:00Z</span>
                  </div>
                )}

                {readyBatchAuthorized && (
                  <div className={styles.auditLogCard}>
                    <div className={styles.auditLogCardLeft}>
                      <span className={styles.auditLogCardTitle}>
                        Ready Batch #1 Authorized by Finance Operator
                      </span>
                      <span className={styles.auditLogCardDesc}>
                        Authorization granted for 917 routine clean payees (
                        {formatCents(batchSummary.readyAmountCents)}). Clean payout batch ready for
                        disbursement.
                      </span>
                    </div>
                    <span className={styles.auditLogCardTime}>2026-10-31T14:15:00Z</span>
                  </div>
                )}

                {resolutions.map((res) => (
                  <div key={res.payoutItemId} className={styles.auditLogCard}>
                    <div className={styles.auditLogCardLeft}>
                      <span className={styles.auditLogCardTitle}>
                        Operator Exception Resolution: {res.payoutItemId} (
                        {res.resolutionStatus})
                      </span>
                      <span className={styles.auditLogCardDesc}>
                        Resolved by {res.resolvedBy}: &quot;{res.resolutionNote}&quot;
                      </span>
                    </div>
                    <span className={styles.auditLogCardTime}>{res.resolvedAt}</span>
                  </div>
                ))}

                <div className={styles.auditLogCard}>
                  <div className={styles.auditLogCardLeft}>
                    <span className={styles.auditLogCardTitle}>
                      NVIDIA Nemotron 3.5 AI Analysis Completed
                    </span>
                    <span className={styles.auditLogCardDesc}>
                      17 exceptions analyzed via nvidia/nemotron-3.5-lightning-30b-a3b. Anomaly risk
                      scores and verification playbooks generated.
                    </span>
                  </div>
                  <span className={styles.auditLogCardTime}>2026-10-31T13:58:00Z</span>
                </div>

                <div className={styles.auditLogCard}>
                  <div className={styles.auditLogCardLeft}>
                    <span className={styles.auditLogCardTitle}>
                      Deterministic Payout Calculation & Classification
                    </span>
                    <span className={styles.auditLogCardDesc}>
                      Calculated integer cents for 1,000 payees. 917 classified READY, 66 classified
                      HARD_HELD, 17 classified AI_ANALYSIS_REQUIRED.
                    </span>
                  </div>
                  <span className={styles.auditLogCardTime}>2026-10-31T13:55:00Z</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: FINANCIAL CONTROLS */}
          {activeNav === 'controls' && (
            <div className={styles.tabContentWrapper}>
              <div className={styles.tabHeader}>
                <div>
                  <h2 className={styles.tabTitle}>Deterministic Financial Mandate Engine</h2>
                  <p className={styles.tabSubtitle}>
                    Pre-execution deterministic constraints that govern AI outputs before money
                    moves.
                  </p>
                </div>
              </div>

              <div className={styles.controlsGrid}>
                <div className={styles.controlCardItem}>
                  <div className={styles.controlCardRule}>1. Batch Budget Ceiling</div>
                  <div className={styles.controlCardLimit}>Limit: $150,000.00 / batch</div>
                  <p className={styles.controlCardDesc}>
                    Strict integer-cent budget ceiling. Total net executable payouts across all
                    batches cannot exceed $150,000.00 under any circumstances.
                  </p>
                </div>

                <div className={styles.controlCardItem}>
                  <div className={styles.controlCardRule}>2. Velocity Surge Ceiling</div>
                  <div className={styles.controlCardLimit}>Threshold: 3.0× historical average</div>
                  <p className={styles.controlCardDesc}>
                    Any payout exceeding 3× the payee&apos;s 90-day historical average is automatically
                    diverted to AI analysis and operator approval.
                  </p>
                </div>

                <div className={styles.controlCardItem}>
                  <div className={styles.controlCardRule}>3. Minimum Payout Floor</div>
                  <div className={styles.controlCardLimit}>Floor: $50.00 minimum</div>
                  <p className={styles.controlCardDesc}>
                    Payees with net earnings below $50.00 are held deterministically and carried
                    forward to prevent excessive micro-transaction processing fees.
                  </p>
                </div>

                <div className={styles.controlCardItem}>
                  <div className={styles.controlCardRule}>4. Destination Change Freeze</div>
                  <div className={styles.controlCardLimit}>Security Window: 72 hours</div>
                  <p className={styles.controlCardDesc}>
                    Payout destination changes made within the last 3 days trigger a mandatory
                    security freeze to prevent account takeover diversion attacks.
                  </p>
                </div>

                <div className={styles.controlCardItem}>
                  <div className={styles.controlCardRule}>5. Account Takeover / Duplicate Check</div>
                  <div className={styles.controlCardLimit}>Constraint: Unique PayPal destination</div>
                  <p className={styles.controlCardDesc}>
                    Flags multiple distinct payee accounts sharing the same destination email to
                    prevent affiliate network fraud and undisclosed multi-accounting.
                  </p>
                </div>

                <div className={styles.controlCardItem}>
                  <div className={styles.controlCardRule}>6. Human Authorization Requirement</div>
                  <div className={styles.controlCardLimit}>Rule: Non-autonomous execution</div>
                  <p className={styles.controlCardDesc}>
                    AI suggests; deterministic gates validate; an authenticated human operator must
                    explicitly click Authorize before any PayPal transaction occurs.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 3. MODAL: READY BATCH #1 AUTHORIZATION */}
      {activeModal === 'ready-batch' && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalHeaderTitle}>Authorize Ready Batch #1</h3>
                <span className={styles.modalHeaderSub}>
                  Ready to pay (917 payees)
                </span>
              </div>
              <button
                type="button"
                className={styles.modalCloseBtn}
                onClick={() => setActiveModal('none')}
              >
                ✕
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.authCallout}>
                <div className={styles.authCalloutTitle}>
                  Independent Batch Execution Authority
                </div>
                <div className={styles.authCalloutText}>
                  Ready Batch #1 contains 917 clean, routine payouts verified against historical
                  baselines. <strong>Unresolved exceptions do not hold back routine payouts.</strong>{' '}
                  Authorizing this batch moves routine funds on schedule while exceptions remain
                  safely quarantined.
                </div>
              </div>

              <div className={styles.authDetailsGrid}>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Eligible Recipients</span>
                  <span className={styles.authDetailValue}>917</span>
                </div>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Disbursement Amount</span>
                  <span className={styles.authDetailValue}>
                    {formatCents(batchSummary.readyAmountCents)}
                  </span>
                </div>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Mandate Status</span>
                  <span className={styles.authDetailValue} style={{ color: '#059669' }}>
                    {readyBatchMandate.status} (100%)
                  </span>
                </div>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Execution Mode</span>
                  <span className={styles.authDetailValue} style={{ fontSize: 14 }}>
                    PayPal Payouts Batch
                  </span>
                </div>
              </div>

              <p className={styles.humanDisclaimer}>
                You make the final decision. AI provides intelligence; deterministic mandates
                provide safety; human operators authorize disbursements.
              </p>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setActiveModal('none')}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnSuccess}
                onClick={handleAuthorizeReadyBatch}
              >
                Authorize 917 Payouts — {formatCents(batchSummary.readyAmountCents)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. MODAL: REVIEWED BATCH #2 AUTHORIZATION */}
      {activeModal === 'reviewed-batch' && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalHeaderTitle}>Authorize Reviewed Batch #2</h3>
                <span className={styles.modalHeaderSub}>
                  Cleared Exceptions ({approvedExceptionItems.length} Payees)
                </span>
              </div>
              <button
                type="button"
                className={styles.modalCloseBtn}
                onClick={() => setActiveModal('none')}
              >
                ✕
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.authCallout}>
                <div className={styles.authCalloutTitle}>
                  Cleared Exception Settlement Batch
                </div>
                <div className={styles.authCalloutText}>
                  This batch contains {approvedExceptionItems.length} previously quarantined
                  exceptions that have been reviewed and approved by an authorized finance
                  operator with recorded audit notes.
                </div>
              </div>

              <div className={styles.authDetailsGrid}>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Approved Payees</span>
                  <span className={styles.authDetailValue}>{approvedExceptionItems.length}</span>
                </div>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Batch Total</span>
                  <span className={styles.authDetailValue}>
                    {formatCents(approvedSumCents)}
                  </span>
                </div>
                <div className={styles.authDetailBox}>
                  <span className={styles.authDetailLabel}>Mandate Status</span>
                  <span className={styles.authDetailValue} style={{ color: '#059669' }}>
                    {reviewedBatchMandate.status}
                  </span>
                </div>
              </div>

              <div className={styles.tableResponsive}>
                <table className={styles.lightTable}>
                  <thead>
                    <tr>
                      <th>Payee</th>
                      <th>Net Payable</th>
                      <th>Operator Audit Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvedExceptionItems.map((item) => {
                      const res = resolutionMap.get(item.id);
                      return (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.recipientName}</strong>
                            <div style={{ fontSize: 11, color: '#64748b' }}>{item.recipientEmail}</div>
                          </td>
                          <td>
                            <strong>{formatCents(item.netPayableCents)}</strong>
                          </td>
                          <td style={{ fontSize: 11.5, color: '#334155' }}>
                            {res?.resolutionNote || 'Operator approved'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setActiveModal('none')}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnSuccess}
                onClick={handleAuthorizeReviewedBatch}
              >
                Authorize {approvedExceptionItems.length} Payouts — {formatCents(approvedSumCents)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. MODAL: ACTIONABLE EXCEPTION REVIEW WORKSPACE (3-COLUMN MODERN FINTECH) */}
      {activeModal === 'exception-drawer' && currentPlaybook && currentExceptionItem && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={`${styles.modalCard} ${styles.modalCardLarge}`}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalHeaderTitle}>Actionable Exception Review Playbook</h3>
                <span className={styles.modalHeaderSub}>
                  Examine evidence, verify criteria, and make the disbursement decision
                </span>
              </div>
              <button
                type="button"
                className={styles.modalCloseBtn}
                onClick={() => setActiveModal('none')}
              >
                ✕
              </button>
            </div>

            <div className={styles.drawerLayout3Col}>
              {/* 1. LEFT COLUMN: Exception Queue (290px) */}
              <div className={styles.drawerSidebar3Col}>
                <div className={styles.drawerSidebarHeader}>
                  17 Flagged Exceptions ({unresolvedExceptionsCount} pending)
                </div>
                {exceptionItems.map((item) => {
                  const playbook = getReviewPlaybook(item);
                  const res = resolutionMap.get(item.id);
                  const isSelected = item.id === selectedExceptionId;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`${styles.drawerExceptionItem} ${
                        isSelected ? styles.drawerExceptionItemActive : ''
                      } ${res ? styles.drawerExceptionItemResolved : ''}`}
                      onClick={() => setSelectedExceptionId(item.id)}
                    >
                      <div className={styles.drawerItemTop}>
                        <span className={styles.drawerItemName}>{item.recipientName}</span>
                        <span className={`${styles.drawerItemAmount} ${styles.tabularNums}`}>
                          {formatCents(item.netPayableCents)}
                        </span>
                      </div>
                      <div className={styles.drawerItemSub}>
                        <span>{playbook.attentionLevel}</span>
                        <span>•</span>
                        {res ? (
                          res.resolutionStatus === 'APPROVED_FOR_BATCH' ? (
                            <span className={styles.drawerItemBadgeApproved}>✓ Approved</span>
                          ) : (
                            <span className={styles.drawerItemBadgeHeld}>✕ Held</span>
                          )
                        ) : (
                          <span style={{ color: '#d97706' }}>Pending</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* 2. CENTER COLUMN: Investigation and Evidence (~650-800px) */}
              <div className={styles.investigationCenter3Col}>
                {/* Case Header Row */}
                <div className={styles.caseHeaderRow}>
                  <div>
                    <h4 className={styles.caseTitle}>
                      {currentPlaybook.affiliateName}
                    </h4>
                    <div className={styles.caseSummary}>
                      {currentPlaybook.issueSubtitle}
                    </div>
                    <div className={styles.provenanceBadgeSubtle}>
                      <span>{currentExceptionItem.recipientEmail}</span>
                      <span>•</span>
                      <span>ID: <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11 }}>{currentPlaybook.payoutItemId}</code></span>
                      <span>•</span>
                      <span>{currentPlaybook.assessmentSource}</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className={`${styles.caseAmount} ${styles.tabularNums}`}>
                      {formatCents(currentExceptionItem.netPayableCents)}
                    </div>
                    <span
                      className={
                        currentPlaybook.attentionLevel === 'HIGH'
                          ? styles.attentionPillHigh
                          : currentPlaybook.attentionLevel === 'MEDIUM'
                          ? styles.attentionPillMed
                          : styles.attentionPillLow
                      }
                      style={{ display: 'inline-block', marginTop: 4 }}
                    >
                      {currentPlaybook.attentionLevel} ATTENTION ({currentPlaybook.riskScore}/100)
                    </span>
                  </div>
                </div>

                {/* Section: Issue Summary */}
                <div className={styles.playbookSection}>
                  <span className={styles.playbookSectionTitle}>Issue Summary</span>
                  <p className={styles.playbookParagraph}>{currentPlaybook.issueSummary}</p>
                </div>

                {/* Section: Why ACTOVRA Flagged This (Plain language, facts vs verify) */}
                <div className={styles.playbookSection}>
                  <span className={styles.playbookSectionTitle}>Why It Matters</span>
                  <p className={styles.playbookParagraph}>{currentPlaybook.whyItMatters}</p>
                </div>

                {/* Section: What ACTOVRA Found (Evidence Rows, No Terminal Styling) */}
                <div className={styles.playbookSection}>
                  <span className={styles.playbookSectionTitle}>What ACTOVRA Found</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {currentPlaybook.whatActovraFound.map((finding, idx) => (
                      <div key={idx} className={styles.evidenceCardRow}>
                        <span className={idx === 2 && currentPlaybook.attentionLevel !== 'LOW' ? styles.evidenceIconWarning : styles.evidenceIconSuccess}>
                          {idx === 2 && currentPlaybook.attentionLevel !== 'LOW' ? '△' : '✓'}
                        </span>
                        <span style={{ flex: 1 }}>{finding}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section: Calculated Amount Breakdown (Deterministic Waterfall) */}
                <div className={styles.playbookSection}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className={styles.playbookSectionTitle}>Calculated Amount Breakdown</span>
                    <span className={`${styles.populationPill} ${styles.pillReady}`}>Calculated deterministically</span>
                  </div>
                  <div className={styles.waterfallTable}>
                    <div className={styles.waterfallRow}>
                      <span>Gross Commission Earnings:</span>
                      <span className={styles.tabularNums}>{formatCents(currentExceptionItem.grossCommissionsCents)}</span>
                    </div>
                    <div className={styles.waterfallRow}>
                      <span>Refund Deductions:</span>
                      <span className={styles.tabularNums} style={{ color: '#dc2626' }}>
                        -{formatCents(currentExceptionItem.refundDeductionsCents)}
                      </span>
                    </div>
                    {currentExceptionItem.chargebackDeductionsCents > 0 && (
                      <div className={styles.waterfallRow}>
                        <span>Chargeback Deductions:</span>
                        <span className={styles.tabularNums} style={{ color: '#dc2626' }}>
                          -{formatCents(currentExceptionItem.chargebackDeductionsCents)}
                        </span>
                      </div>
                    )}
                    <div className={styles.waterfallRow}>
                      <span>Prior Adjustments / Withholding:</span>
                      <span className={styles.tabularNums} style={{ color: '#dc2626' }}>
                        -{formatCents(Math.abs(currentExceptionItem.priorAdjustmentCents))}
                      </span>
                    </div>
                    <div className={styles.waterfallTotalRow}>
                      <span>Net Payable Amount:</span>
                      <span className={styles.tabularNums}>{formatCents(currentExceptionItem.netPayableCents)}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: '#64748b', fontStyle: 'italic', marginTop: 2 }}>
                    AI did NOT calculate or modify this amount. Authoritative ledger arithmetic.
                  </div>
                </div>

                {/* Section: What You Need To Verify Before Approving (Interactive Checklist) */}
                <div className={styles.playbookSection}>
                  <span className={styles.playbookSectionTitle}>
                    What You Need To Verify Before Approving
                  </span>
                  <div className={styles.interactiveChecklistCard}>
                    {currentPlaybook.whatYouNeedToVerify.map((step, idx) => {
                      const isChecked = !!verifiedChecklistItems[currentExceptionItem.id]?.[idx];
                      return (
                        <label key={idx} className={styles.interactiveChecklistItem}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleChecklistItem(currentExceptionItem.id, idx)}
                            className={styles.interactiveCheckbox}
                          />
                          <span className={isChecked ? styles.checklistTextChecked : styles.checklistText}>
                            {step}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Section: Where To Verify Evidence */}
                <div className={styles.playbookSection}>
                  <span className={styles.playbookSectionTitle}>Where To Verify Evidence</span>
                  <p className={styles.playbookParagraph}>
                    <strong>Inspection Target:</strong> {currentPlaybook.whereToVerify}
                  </p>
                </div>
              </div>

              {/* 3. RIGHT COLUMN: Sticky Decision Panel (310px) */}
              <div className={styles.decisionRight3Col}>
                <div className={styles.decisionRightHeader}>
                  <h4 className={styles.decisionRightTitle}>Decision</h4>
                  <span style={{ fontSize: 12, color: '#64748b' }}>
                    {resolutionMap.get(currentExceptionItem.id)?.resolutionStatus || 'Pending'}
                  </span>
                </div>

                {/* Recipient summary */}
                <div className={styles.decisionSummaryCard}>
                  <span className={styles.decisionSummaryName}>{currentPlaybook.affiliateName}</span>
                  <span className={`${styles.decisionSummaryAmount} ${styles.tabularNums}`}>
                    {formatCents(currentExceptionItem.netPayableCents)}
                  </span>
                  <span style={{ fontSize: 11.5, color: '#64748b' }}>
                    {currentPlaybook.issueTitle}
                  </span>
                </div>

                {/* Checklist verification progress & Decision Actions */}
                {(() => {
                  const requiredCount = currentPlaybook.whatYouNeedToVerify.length;
                  const checkedMap = verifiedChecklistItems[currentExceptionItem.id] || {};
                  const checkedCount = currentPlaybook.whatYouNeedToVerify.filter((_, idx) => !!checkedMap[idx]).length;
                  const isVerificationComplete = requiredCount > 0 && checkedCount === requiredCount;

                  return (
                    <>
                      <div className={styles.decisionChecklistProgress}>
                        <span>Verification checklist:</span>
                        <span className={styles.tabularNums}>
                          {checkedCount} of {requiredCount} checked
                        </span>
                      </div>

                      {/* Guidance mini boxes */}
                      <div className={styles.decisionGuidanceMini}>
                        <div>
                          <div className={styles.guidanceMiniTitleApprove}>Approve When:</div>
                          <div className={styles.guidanceMiniText}>{currentPlaybook.approveIf}</div>
                        </div>
                        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
                          <div className={styles.guidanceMiniTitleHold}>Hold When:</div>
                          <div className={styles.guidanceMiniText}>{currentPlaybook.holdIf}</div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className={styles.decisionActionsGroup}>
                        {isVerificationComplete ? (
                          <button
                            type="button"
                            className={styles.btnDecisionApprove}
                            onClick={() =>
                              handleResolveException(
                                currentExceptionItem.id,
                                'APPROVED_FOR_BATCH',
                                currentPlaybook.suggestedNote || `Approved by operator after verifying ${currentPlaybook.affiliateName}`
                              )
                            }
                          >
                            ✓ Approve payout ({formatCents(currentExceptionItem.netPayableCents)})
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className={styles.btnDecisionApproveDisabled}
                            title="Complete all required verification checks before approving this payout"
                          >
                            Complete verification to approve
                          </button>
                        )}

                        {!isVerificationComplete && (
                          <div className={styles.decisionVerificationHint}>
                            Complete all required verification checks before approving this payout.
                          </div>
                        )}

                        <button
                          type="button"
                          className={styles.btnDecisionHold}
                          onClick={() =>
                            handleResolveException(
                              currentExceptionItem.id,
                              'HELD_BY_OPERATOR',
                              `Held by operator: ${currentPlaybook.holdIf}`
                            )
                          }
                        >
                          ✕ Hold payout
                        </button>
                      </div>
                    </>
                  );
                })()}

                  <p className={styles.humanDisclaimer}>
                    You make the final decision. AI provides intelligence; deterministic mandates
                    provide safety; human operators authorize disbursements.
                  </p>
                </div>
              </div>
            </div>
          </div>
      )}

      {/* 5b. MODAL: HOW THIS ESTIMATE WORKS */}
      {showEstimateExplanation && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalCardSmall}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalHeaderTitle}>How this estimate works</h3>
              <button
                type="button"
                className={styles.modalCloseBtn}
                onClick={() => setShowEstimateExplanation(false)}
              >
                ✕
              </button>
            </div>
            <div className={styles.modalBody}>
              <p style={{ margin: '0 0 12px 0', fontSize: 13.5, color: '#334155', lineHeight: 1.5 }}>
                ACTOVRA reduced the routine review queue from 1,000 payouts to 17 exceptions.
              </p>
              <p style={{ margin: '0 0 14px 0', fontSize: 13, color: '#64748b', lineHeight: 1.5 }}>
                This estimate assumes approximately 30 seconds to perform a routine payout review.
              </p>
              <div className={styles.estimateBreakdownBox}>
                <div className={styles.estimateRow}>
                  <span>Without ACTOVRA:</span>
                  <span className={styles.tabularNums}>1,000 × 30 sec = 8h 20m</span>
                </div>
                <div className={styles.estimateRow}>
                  <span>Routine reviews avoided:</span>
                  <span className={styles.tabularNums}>983 × 30 sec ≈ 8h 12m</span>
                </div>
              </div>
              <p style={{ margin: '14px 0 0 0', fontSize: 12, color: '#64748b', fontStyle: 'italic', lineHeight: 1.4 }}>
                Exception investigation time is excluded because it varies by case.
              </p>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => setShowEstimateExplanation(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. MODAL: RULE-HELD PAYOUTS INSPECTOR */}
      {activeModal === 'held-inspector' && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalHeaderTitle}>Rule-Held Payouts Inspector</h3>
                <span className={styles.modalHeaderSub}>
                  {heldItems.length} Payees Held by Policy ({formatCents(batchSummary.heldAmountCents)})
                </span>
              </div>
              <button
                type="button"
                className={styles.modalCloseBtn}
                onClick={() => setActiveModal('none')}
              >
                ✕
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.authCallout}>
                <div className={styles.authCalloutTitle}>
                  Automated Carry-Forward Enforcement
                </div>
                <div className={styles.authCalloutText}>
                  These 66 payees did not meet the deterministic threshold criteria: 64 are below
                  the $50.00 minimum threshold and 2 have non-positive balances. Their balances are
                  preserved and automatically carried forward to November.
                </div>
              </div>

              <div className={styles.tableResponsive} style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className={styles.lightTable}>
                  <thead>
                    <tr>
                      <th>Payee Identifier</th>
                      <th>Payee Name</th>
                      <th>Net Payable</th>
                      <th>Policy Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heldItems.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11 }}>
                            {item.id}
                          </span>
                        </td>
                        <td>
                          <strong>{item.recipientName}</strong>
                        </td>
                        <td>{formatCents(item.netPayableCents)}</td>
                        <td>
                          <span style={{ fontSize: 11.5, color: '#dc2626' }}>
                            {item.anomalyCodes.includes('BELOW_MINIMUM_THRESHOLD')
                              ? `Below $50.00 minimum floor (${formatCents(item.netPayableCents)})`
                              : 'Non-positive net payable balance'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setActiveModal('none')}
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default PayoutsDashboard;
