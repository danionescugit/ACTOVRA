"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import styles from "./page.module.css";
import { syntheticOpportunities } from "../domain/data";
import { PayoutsDashboard } from "../components/PayoutsDashboard";

interface AuditEntry {
  sequence: number;
  eventType: string;
  occurredAt: string;
}

interface OperationRepresentation {
  operationId: string;
  opportunityId: string;
  opportunity: { id: string; title: string; description?: string } | null;
  status: string;
  decision: {
    opportunityId: string;
    action: string;
    amount: number;
    currency: string;
    recipient: string;
    justification: string;
    provenance?: "REAL_AI" | "SYNTHETIC_FALLBACK";
  } | null;
  amount: number | null;
  currency: string | null;
  justification: string | null;
  policyResult: {
    decision: "APPROVE" | "REJECT" | "ESCALATE";
    reason: string;
  } | null;
  approvalStatus: string | null;
  paypalOrder: {
    paypalOrderId: string;
    paypalStatus: string;
  } | null;
  approvalUrl: string | null;
  paymentResult: {
    success: boolean;
    transactionId: string | null;
    captureId: string | null;
    paypalOrderId: string | null;
    amount: number | null;
    currency: string | null;
  } | null;
  auditTrail: AuditEntry[];
  createdAt: string;
  updatedAt: string;
  nextAction: string | null;
}

const STATIC_PREVIEWS: Record<
  string,
  {
    action: string;
    amount: number;
    currency: string;
    recipient: string;
    justification: string;
    policyDecision: "APPROVE" | "ESCALATE";
    policyReason: string;
  }
> = {
  "opp-001": {
    action: "CREATE_PAYMENT",
    amount: 2500,
    currency: "USD",
    recipient: "customer-demo-001",
    justification: "Synthetic proposal: execute the summer promotion payment",
    policyDecision: "APPROVE",
    policyReason: "Amount $25.00 is within automatic threshold ($50.00)",
  },
  "opp-002": {
    action: "CREATE_PAYMENT",
    amount: 45000,
    currency: "USD",
    recipient: "customer-demo-001",
    justification: "Synthetic proposal: bulk purchase rebate exceeding the automatic threshold",
    policyDecision: "ESCALATE",
    policyReason: "Amount $450.00 exceeds automatic threshold ($50.00). Human review required.",
  },
  "opp-003": {
    action: "CREATE_PAYMENT",
    amount: 2500,
    currency: "USD",
    recipient: "customer-demo-001",
    justification: "Synthetic proposal: new customer welcome credit payment",
    policyDecision: "APPROVE",
    policyReason: "Amount $25.00 is within automatic threshold ($50.00)",
  },
};

function formatMoney(amountInCents: number, currency = "USD") {
  return `$${(amountInCents / 100).toFixed(2)} ${currency}`;
}

function formatAction(action: string | null | undefined): string {
  if (!action) return "—";
  if (action === "CREATE_PAYMENT") return "Create payment";
  return action;
}

function sandboxApprovalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["www.sandbox.paypal.com", "sandbox.paypal.com"].includes(url.hostname) &&
      !url.username && !url.password && !url.port
      ? value
      : null;
  } catch {
    return null;
  }
}

const executionKey = (id: string) => `commercepilot:execution-attempt:${id}`;

function executionAttempted(id: string): boolean {
  try { return sessionStorage.getItem(executionKey(id)) === "started"; }
  catch { return false; }
}

async function readOperations(): Promise<OperationRepresentation[]> {
  const res = await fetch("/api/operations", { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("Could not read persistent operations.");
  const data = await res.json();
  if (!Array.isArray(data.operations)) throw new Error("Invalid operations response.");
  return data.operations;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<'payouts' | 'operations'>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'operations' || params.get('operation') || params.get('paypal')) {
        return 'operations';
      }
    }
    return 'payouts';
  });
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string>("opp-001");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [operations, setOperations] = useState<OperationRepresentation[]>([]);
  const [operationsLoaded, setOperationsLoaded] = useState(false);
  const [executionAttempts, setExecutionAttempts] = useState<string[]>([]);
  const executionInFlight = useRef(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    text: string;
    approvalUrl?: string | null;
  } | null>(null);

  const fetchOperations = useCallback(async () => {
    const persisted = await readOperations();
    setOperations(persisted);
    setOperationsLoaded(true);
    if (!operationsLoaded) {
      const params = new URLSearchParams(window.location.search);
      const targetId = params.get("operation");
      const target = persisted.find(op => op.operationId === targetId);
      if (target) {
        setSelectedOperationId(target.operationId);
        setSelectedOpportunityId(target.opportunityId);
        const paypalParam = params.get("paypal");
        if (paypalParam === "returned" && (target.status === "COMPLETED" || (target.status === "OUTCOME_RECORDED" && target.paymentResult?.success))) {
          const amt = target.amount != null ? formatMoney(target.amount, target.currency || "USD") : null;
          const captureId = target.paymentResult?.captureId;
          const metaParts = [
            amt ? `Amount: ${amt}` : null,
            captureId ? `Capture ID: ${captureId}` : null,
          ].filter(Boolean);
          const details = metaParts.length > 0 ? ` (${metaParts.join(" • ")})` : "";
          setNotification({
            type: "success",
            text: `PayPal payment completed successfully.${details}`,
          });
        }
      }
      setExecutionAttempts(previous => [...new Set([
        ...previous, ...persisted.filter(op => executionAttempted(op.operationId)).map(op => op.operationId),
      ])]);
    }
  }, [operationsLoaded]);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const persisted = await readOperations();
        if (!ignore) {
          setOperations(persisted);
          setOperationsLoaded(true);
          setExecutionAttempts(persisted.filter(op => executionAttempted(op.operationId)).map(op => op.operationId));
          const params = new URLSearchParams(window.location.search);
          const targetId = params.get("operation");
          const target = persisted.find(op => op.operationId === targetId);
          if (target) {
            setSelectedOperationId(target.operationId);
            setSelectedOpportunityId(target.opportunityId);
            const paypalParam = params.get("paypal");
            if (paypalParam === "returned" && (target.status === "COMPLETED" || (target.status === "OUTCOME_RECORDED" && target.paymentResult?.success))) {
              const amt = target.amount != null ? formatMoney(target.amount, target.currency || "USD") : null;
              const captureId = target.paymentResult?.captureId;
              const metaParts = [
                amt ? `Amount: ${amt}` : null,
                captureId ? `Capture ID: ${captureId}` : null,
              ].filter(Boolean);
              const details = metaParts.length > 0 ? ` (${metaParts.join(" • ")})` : "";
              setNotification({
                type: "success",
                text: `PayPal payment completed successfully.${details}`,
              });
            } else if (paypalParam === "approval-not-completed") {
              setNotification({
                type: "error",
                text: "PayPal checkout was cancelled or not completed. The operation remains ready for review.",
              });
            }
          } else if (targetId) {
            setNotification({ type: "error", text: "The returned operation was not found. Refresh status before taking further action." });
          }
        }
      } catch {
        if (!ignore) setNotification({ type: "error", text: "Could not load persistent operations. Refresh status before taking further action." });
      }
    }
    load();
    return () => {
      ignore = true;
    };
  }, []);

  // Find active operation for the selected opportunity
  const selectedOperation = selectedOperationId
    ? operations.find(op => op.operationId === selectedOperationId)
    : operations.find(op => op.opportunityId === selectedOpportunityId);
  const approvalUrl = sandboxApprovalUrl(selectedOperation?.approvalUrl ?? null);
  const executionBlocked = !!selectedOperation && executionAttempts.includes(selectedOperation.operationId);
  const selectedOpportunity =
    syntheticOpportunities.find((o) => o.id === selectedOpportunityId) || syntheticOpportunities[0];
  const staticPreview = STATIC_PREVIEWS[selectedOpportunityId] || STATIC_PREVIEWS["opp-001"];

  // KPI Calculations
  const totalOpportunities = syntheticOpportunities.length;
  const awaitingApprovalCount = operations.filter((op) => op.status === "AWAITING_HUMAN_APPROVAL").length;
  const approvedCount = operations.filter((op) => op.status === "APPROVED" || op.approvalStatus === "APPROVED").length;
  const completedCount = operations.filter((op) => op.status === "COMPLETED" || (op.status === "OUTCOME_RECORDED" && op.paymentResult?.success)).length;

  // Step resolution for state flow
  const currentStep = !selectedOperation
    ? 1
    : selectedOperation.status === "AWAITING_HUMAN_APPROVAL"
    ? 4
    : ["APPROVED", "EXECUTING", "PAYPAL_ORDER_CREATED", "CAPTURE_EXECUTING"].includes(selectedOperation.status)
    ? 5
    : ["COMPLETED", "FAILED", "OUTCOME_RECORDED"].includes(selectedOperation.status)
    ? 6
    : 4;

  const handlePropose = async (opportunityId: string) => {
    setActionLoading(`propose-${opportunityId}`);
    setNotification(null);
    try {
      const res = await fetch("/api/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId }),
      });
      if (res.ok) {
        await fetchOperations();
        setNotification({
          type: "success",
          text: `Operation initiated for ${opportunityId}. AI Decision proposed and verified by Policy Gate.`,
        });
      } else {
        const err = await res.json().catch(() => ({}));
        setNotification({
          type: "error",
          text: err.error?.message || "Failed to initiate operation.",
        });
      }
    } catch {
      setNotification({ type: "error", text: "Network error calling operations API." });
    } finally {
      setActionLoading(null);
    }
  };

  const handleApprove = async (operationId: string) => {
    setActionLoading(`approve-${operationId}`);
    setNotification(null);
    try {
      const res = await fetch(`/api/operations/${encodeURIComponent(operationId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        await fetchOperations();
        setNotification({
          type: "success",
          text: `Human approval recorded durably. Operation ${operationId} is now APPROVED.`,
        });
      } else {
        const err = await res.json().catch(() => ({}));
        setNotification({
          type: "error",
          text: err.error?.message || "Approval could not be completed.",
        });
      }
    } catch {
      setNotification({ type: "error", text: "Network error calling approval endpoint." });
    } finally {
      setActionLoading(null);
    }
  };

  const handleExecute = async (operation: OperationRepresentation) => {
    const operationId = operation.operationId;
    if (executionInFlight.current || executionAttempts.includes(operationId) || executionAttempted(operationId)) return;
    // Claim synchronously: React's next render alone cannot prevent two clicks.
    executionInFlight.current = true;
    setExecutionAttempts(previous => [...previous, operationId]);
    try { sessionStorage.setItem(executionKey(operationId), "started"); } catch { /* In-memory guard remains active. */ }
    setActionLoading(`execute-${operationId}`);
    setNotification(null);
    try {
      const res = await fetch(`/api/operations/${encodeURIComponent(operationId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const updated: OperationRepresentation | undefined = res.ok ? data : data.operation;
      const valid = updated?.operationId === operationId &&
        updated.opportunityId === operation.opportunityId && typeof updated.status === "string" && Array.isArray(updated.auditTrail);
      if (valid) {
        setOperations(previous => previous.map(op => op.operationId === operationId ? updated : op));
      }
      if (!res.ok || !valid || updated.status !== "PAYPAL_ORDER_CREATED") {
        setNotification({ type: "error", text: res.status === 409
          ? "Execution was not accepted in the current state (409). Refresh status and review the operation before taking further action."
          : "Execution could not be confirmed. Do not repeat execution; refresh status and review the operation." });
        try { await fetchOperations(); } catch { setOperationsLoaded(false); }
        return;
      }
      const validApprovalUrl = sandboxApprovalUrl(updated.approvalUrl);
      setNotification(validApprovalUrl
        ? {
            type: "success",
            text: "PayPal order created. Continue to PayPal Sandbox to approve the payment.",
            approvalUrl: validApprovalUrl,
          }
        : {
            type: "error",
            text: "Order created, but a valid PayPal Sandbox approval link is unavailable. Review the operation; do not execute again.",
          });
    } catch {
      setNotification({ type: "error", text: "Execution response is unknown. Do not repeat execution; refresh status and review the operation." });
      try { await fetchOperations(); } catch { setOperationsLoaded(false); }
    } finally {
      executionInFlight.current = false;
      setActionLoading(null);
    }
  };

  const handleRefresh = async () => {
    setActionLoading("refresh");
    try { await fetchOperations(); }
    catch {
      setOperationsLoaded(false);
      setNotification({ type: "error", text: "Could not refresh persistent status. No execution has been retried." });
    } finally { setActionLoading(null); }
  };

  return (
    <div className={activeTab === 'payouts' ? styles.payoutsShellWrapper : styles.container}>
      {/* Top Application Mode Navigation */}
      <nav className={styles.appTopNav}>
        <div className={styles.navBrand}>
          <span className={styles.navLogo}>ACTOVRA</span>
          <span className={styles.navTagline}>AI-Controlled Financial Operations</span>
        </div>
        <div className={styles.navTabs}>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === 'payouts' ? styles.navTabBtnActive : ''}`}
            onClick={() => setActiveTab('payouts')}
          >
            Payout Intelligence (Mass Payouts)
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === 'operations' ? styles.navTabBtnActive : ''}`}
            onClick={() => setActiveTab('operations')}
          >
            Single Payment Demo
          </button>
        </div>
      </nav>

      {activeTab === 'payouts' ? (
        <PayoutsDashboard />
      ) : (
        <>
          {/* Header */}
          <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.logoIcon}>A</div>
          <div className={styles.titleGroup}>
            <h1>ACTOVRA</h1>
            <p>
              Where AI decisions become controlled actions.{" "}
              <span className={styles.taglineDescriptor}>
                Controlled execution for AI-driven commerce
              </span>
            </p>
          </div>
        </div>
        <div className={styles.headerBadges}>
          <span className={styles.badgeSandbox}>
            <span className={styles.pulseDot} />
            Policy Guard Active
          </span>
        </div>
      </header>

      {/* State Flow Stepper Banner */}
      <div className={styles.stepperBar}>
        <div className={`${styles.stepItem} ${currentStep >= 1 ? styles.stepActive : ""}`}>
          <span className={styles.stepNumber}>1</span>
          <span>Opportunity</span>
        </div>
        <span className={styles.stepArrow}>→</span>
        <div className={`${styles.stepItem} ${currentStep >= 2 ? styles.stepActive : ""}`}>
          <span className={styles.stepNumber}>2</span>
          <span>AI Decision</span>
        </div>
        <span className={styles.stepArrow}>→</span>
        <div className={`${styles.stepItem} ${currentStep >= 3 ? styles.stepActive : ""}`}>
          <span className={styles.stepNumber}>3</span>
          <span>Policy / Risk Gate</span>
        </div>
        <span className={styles.stepArrow}>→</span>
        <div className={`${styles.stepItem} ${currentStep >= 4 ? styles.stepActive : ""}`}>
          <span className={styles.stepNumber}>4</span>
          <span>Human Approval</span>
        </div>
        <span className={styles.stepArrow}>→</span>
        <div className={`${styles.stepItem} ${currentStep >= 5 ? styles.stepActive : ""}`}>
          <span className={styles.stepNumber}>5</span>
          <span>PayPal Execution</span>
        </div>
        <span className={styles.stepArrow}>→</span>
        <div className={`${styles.stepItem} ${currentStep >= 6 ? styles.stepActive : ""}`}>
          <span className={styles.stepNumber}>6</span>
          <span>Outcome & Settlement</span>
        </div>
      </div>

      <main className={styles.main}>
        {/* KPI / Summary Section */}
        <section className={styles.kpiGrid}>
          <div className={styles.kpiCard}>
            <span className={styles.kpiLabel}>Opportunities</span>
            <span className={styles.kpiValue}>{totalOpportunities}</span>
            <span className={styles.kpiHint}>Synthetic catalog items available</span>
          </div>
          <div className={styles.kpiCard}>
            <span className={styles.kpiLabel}>Awaiting Human Approval</span>
            <span className={styles.kpiValue} style={{ color: awaitingApprovalCount > 0 ? "#fbbf24" : undefined }}>
              {awaitingApprovalCount}
            </span>
            <span className={styles.kpiHint}>Policy-passed operations awaiting operator</span>
          </div>
          <div className={styles.kpiCard}>
            <span className={styles.kpiLabel}>Human Approved</span>
            <span className={styles.kpiValue} style={{ color: approvedCount > 0 ? "#34d399" : undefined }}>
              {approvedCount}
            </span>
            <span className={styles.kpiHint}>Authorized for PayPal execution</span>
          </div>
          <div className={styles.kpiCard}>
            <span className={styles.kpiLabel}>Outcomes & Audits</span>
            <span className={styles.kpiValue}>{completedCount}</span>
            <span className={styles.kpiHint}>Transactions executed & recorded</span>
          </div>
        </section>

        {notification && (
          <div
            role={notification.type === "error" ? "alert" : "status"}
            style={{
              padding: "14px 18px",
              borderRadius: "8px",
              fontSize: "14px",
              backgroundColor: notification.type === "success" ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
              border: `1px solid ${notification.type === "success" ? "#10b981" : "#ef4444"}`,
              color: notification.type === "success" ? "#34d399" : "#f87171",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <span style={{ fontWeight: 500 }}>{notification.text}</span>
            {notification.approvalUrl && (
              <a
                className={styles.btnPrimary}
                href={notification.approvalUrl}
                referrerPolicy="no-referrer"
                style={{
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  padding: "8px 16px",
                  fontSize: "13px",
                }}
              >
                Continue to PayPal Sandbox
              </a>
            )}
          </div>
        )}

        {/* Operations Console Table & Detail Workspace */}
        <div className={styles.workspaceGrid}>
          {/* Main Table */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.cardTitle}>
                  <span>Commerce Operations Console</span>
                </div>
                <div className={styles.cardSubtitle}>
                  Select an opportunity to inspect AI decision proposal, policy constraints, and human gate
                </div>
              </div>
            </div>

            <div className={styles.tableContainer}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Opportunity</th>
                    <th>Account</th>
                    <th>Proposed Value</th>
                    <th>AI Recommendation</th>
                    <th>Policy / Risk</th>
                    <th>Operation State</th>
                    <th>Human Gate</th>
                  </tr>
                </thead>
                <tbody>
                  {syntheticOpportunities.map((opp) => {
                    const op = selectedOperation?.opportunityId === opp.id
                      ? selectedOperation : operations.find((o) => o.opportunityId === opp.id);
                    const preview = STATIC_PREVIEWS[opp.id];
                    const isSelected = selectedOpportunityId === opp.id;
                    const amount = op?.amount ?? preview.amount;
                    const currency = op?.currency ?? preview.currency;
                    const action = op?.decision?.action ?? preview.action;
                    const policyDecision = op?.policyResult?.decision ?? preview.policyDecision;
                    const approvalStatus = op?.approvalStatus ?? (op?.status === "AWAITING_HUMAN_APPROVAL" ? "PENDING" : "NOT_SUBMITTED");

                    return (
                      <tr
                        key={opp.id}
                        className={`${styles.tableRow} ${isSelected ? styles.tableRowSelected : ""}`}
                        onClick={() => {
                          setSelectedOpportunityId(opp.id);
                          setSelectedOperationId(op?.operationId ?? null);
                        }}
                      >
                        <td>
                          <div className={styles.opportunityTitle}>
                            <span>{opp.title}</span>
                            <span className={styles.opportunityId}>{opp.id}</span>
                          </div>
                        </td>
                        <td>
                          <span style={{ color: "#94a3b8" }}>{op?.decision?.recipient ?? preview.recipient}</span>
                        </td>
                        <td>
                          <span className={styles.monoValue}>{formatMoney(amount, currency)}</span>
                        </td>
                        <td>
                          <span className={`${styles.badge} ${styles.badgeInfo}`}>{formatAction(action)}</span>
                        </td>
                        <td>
                          {policyDecision === "APPROVE" ? (
                            <span className={`${styles.badge} ${styles.badgeSuccess}`}>Low Risk (Auto ≤ $50)</span>
                          ) : (
                            <span className={`${styles.badge} ${styles.badgeWarning}`}>Review Req (&gt; $50)</span>
                          )}
                        </td>
                        <td>
                          {op ? (
                            <span
                              className={`${styles.badge} ${
                                op.status === "APPROVED" || op.status === "COMPLETED" || (op.status === "OUTCOME_RECORDED" && op.paymentResult?.success)
                                  ? styles.badgeSuccess
                                  : op.status === "AWAITING_HUMAN_APPROVAL"
                                  ? styles.badgeWarning
                                  : styles.badgeInfo
                              }`}
                            >
                              {op.status}
                            </span>
                          ) : (
                            <span className={`${styles.badge} ${styles.badgeNeutral}`}>UNCOMMITTED</span>
                          )}
                        </td>
                        <td>
                          {approvalStatus === "APPROVED" ? (
                            <span className={`${styles.badge} ${styles.badgeSuccess}`}>✓ APPROVED</span>
                          ) : approvalStatus === "PENDING" ? (
                            <span className={`${styles.badge} ${styles.badgeWarning}`}>⏳ AWAITING</span>
                          ) : (
                            <span className={`${styles.badge} ${styles.badgeNeutral}`}>STANDBY</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Detail & Decision Panel */}
          <div className={`${styles.card} ${styles.detailCard}`}>
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>Selected Opportunity</span>
              </div>
              <div className={styles.infoBox}>
                {selectedOperation && <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Operation ID:</span>
                  <span className={styles.infoValue}>{selectedOperation.operationId}</span>
                </div>}
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>ID:</span>
                  <span className={styles.infoValue}>{selectedOpportunity.id}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Title:</span>
                  <span className={styles.infoValue}>{selectedOpportunity.title}</span>
                </div>
                <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "4px" }}>
                  {selectedOpportunity.description}
                </div>
              </div>
            </div>

            {/* AI Commerce Decision */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>AI Commerce Decision (Proposed)</span>
                {selectedOperation?.decision?.provenance && (
                  <span
                    className={`${styles.badge} ${
                      selectedOperation.decision.provenance === "REAL_AI"
                        ? styles.badgeSuccess
                        : styles.badgeNeutral
                    }`}
                  >
                    {selectedOperation.decision.provenance === "REAL_AI"
                      ? "AI-generated proposal"
                      : "Demo fallback proposal"}
                  </span>
                )}
              </div>
              <div className={styles.infoBox}>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Action:</span>
                  <span className={styles.infoValue}>{formatAction(selectedOperation?.decision?.action ?? staticPreview.action)}</span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Proposed Amount:</span>
                  <span className={styles.infoValue}>
                    {formatMoney(
                      selectedOperation?.amount ?? staticPreview.amount,
                      selectedOperation?.currency ?? staticPreview.currency
                    )}
                  </span>
                </div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Recipient:</span>
                  <span className={styles.infoValue}>
                    {selectedOperation?.decision?.recipient ?? staticPreview.recipient}
                  </span>
                </div>
                {selectedOperation?.decision?.provenance && (
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Provenance:</span>
                    <span className={styles.infoValue}>
                      {selectedOperation.decision.provenance === "REAL_AI"
                        ? "NVIDIA Nemotron (Real AI)"
                        : "Deterministic Demo Fallback"}
                    </span>
                  </div>
                )}
                <div className={styles.justification}>
                  <strong>AI Rationale: </strong>
                  {selectedOperation?.justification ?? staticPreview.justification}
                </div>
              </div>
            </div>

            {/* Deterministic Policy Gate */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>Deterministic Policy & Risk Gate</span>
              </div>
              <div className={styles.infoBox}>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Policy Verdict:</span>
                  <span
                    className={`${styles.badge} ${
                      (selectedOperation?.policyResult?.decision ?? staticPreview.policyDecision) === "APPROVE"
                        ? styles.badgeSuccess
                        : styles.badgeWarning
                    }`}
                  >
                    {selectedOperation?.policyResult?.decision ?? staticPreview.policyDecision}
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "4px", lineHeight: 1.4 }}>
                  <strong>Rule: </strong>
                  {selectedOperation?.policyResult?.reason ?? staticPreview.policyReason}
                </div>
              </div>
            </div>

            {/* Human-in-the-Loop Action Box */}
            <div className={styles.actionBox}>
              <div className={styles.actionHeading}>
                <span>Human-in-the-Loop Execution Gate</span>
              </div>
              <p className={styles.actionDescription}>
                AI needs a mandate, not a blank check. Operators maintain absolute control over financial execution.
              </p>

              {!selectedOperation ? (
                <button
                  className={styles.btnPrimary}
                  disabled={actionLoading !== null || !operationsLoaded}
                  onClick={() => handlePropose(selectedOpportunityId)}
                >
                  {actionLoading === `propose-${selectedOpportunityId}` ? "Evaluating Policy..." : "⚡ Analyze with AI & Evaluate Policy"}
                </button>
              ) : selectedOperation.status === "AWAITING_HUMAN_APPROVAL" ? (
                <button
                  className={styles.btnSuccess}
                  disabled={actionLoading !== null || !operationsLoaded}
                  onClick={() => handleApprove(selectedOperation.operationId)}
                >
                  {actionLoading === `approve-${selectedOperation.operationId}` ? "Recording Approval..." : "✓ Grant Human Approval"}
                </button>
              ) : selectedOperation.status === "APPROVED" ? (
                <>
                  <div className={styles.statusNotice}>Human Approval Granted. Ready for PayPal Sandbox Execution.</div>
                  <button className={styles.btnPrimary}
                    disabled={actionLoading !== null || !operationsLoaded || executionBlocked}
                    onClick={() => handleExecute(selectedOperation)}>
                    {actionLoading === `execute-${selectedOperation.operationId}` ? "Creating PayPal order..." : "Execute with PayPal Sandbox"}
                  </button>
                  {executionBlocked && <p className={styles.actionDescription}>
                    Execution was already requested in this session. Refresh status and review the operation before any further execution.
                  </p>}
                </>
              ) : selectedOperation.status === "PAYPAL_ORDER_CREATED" ? (
                <>
                  <div className={styles.statusNotice}>PayPal order created. Buyer approval is required; payment is not yet confirmed.</div>
                  {approvalUrl ? <a className={styles.btnPrimary} href={approvalUrl} referrerPolicy="no-referrer">
                    Continue to PayPal Sandbox
                  </a> : <p role="alert">A valid PayPal Sandbox approval link is unavailable. Review the operation; do not execute again.</p>}
                </>
              ) : selectedOperation.status === "COMPLETED" ||
                (selectedOperation.status === "OUTCOME_RECORDED" && selectedOperation.paymentResult?.success) ? (
                <div role="status" className={styles.statusSuccess}>
                  <div className={styles.statusSuccessHeader}>
                    <span className={styles.successCheck}>✓</span>
                    <strong>Payment completed successfully.</strong>
                  </div>
                  <div className={styles.statusSuccessMeta}>
                    {selectedOperation.amount != null && (
                      <span className={styles.statusSuccessMetaItem}>
                        Amount: {formatMoney(selectedOperation.amount, selectedOperation.currency || "USD")}
                      </span>
                    )}
                    <span className={styles.statusSuccessMetaItem}>
                      Persistent state: {selectedOperation.status}
                    </span>
                    {selectedOperation.paymentResult?.captureId && (
                      <span className={styles.statusSuccessMetaItem}>
                        Capture: {selectedOperation.paymentResult.captureId}
                      </span>
                    )}
                    {selectedOperation.paypalOrder?.paypalOrderId && (
                      <span className={styles.statusSuccessMetaItem}>
                        Order: {selectedOperation.paypalOrder.paypalOrderId}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div role={selectedOperation.status === "FAILED" ? "alert" : "status"} className={styles.statusNotice}>
                  <span>Persistent state: {selectedOperation.status}</span>
                  {selectedOperation.status === "FAILED" ? <span>Payment failed.</span>
                    : <span>Payment completion is not confirmed. Refresh status and review the operation.</span>}
                </div>
              )}
              <button className={styles.btnSecondary} disabled={actionLoading !== null} onClick={handleRefresh}>
                {actionLoading === "refresh" ? "Refreshing status..." : "Refresh status"}
              </button>
            </div>

            {/* Audit Trail */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>Durable Audit Trail</span>
              </div>
              {selectedOperation && selectedOperation.auditTrail && selectedOperation.auditTrail.length > 0 ? (
                <div className={styles.auditList}>
                  {selectedOperation.auditTrail.map((entry) => (
                    <div key={entry.sequence} className={styles.auditItem}>
                      <span className={styles.auditType}>
                        #{entry.sequence} {entry.eventType}
                      </span>
                      <span className={styles.auditTime}>
                        {new Date(entry.occurredAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyNotice}>
                  No events recorded yet. Propose decision to start the audit sequence.
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
        </>
      )}
    </div>
  );
}
