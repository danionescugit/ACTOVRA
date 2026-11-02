# ACTOVRA — Devpost Submission Package

**Project Name:** ACTOVRA  
**Tagline:** Where AI decisions become controlled actions.  
**One-Line Description:** Controlled execution for AI-driven commerce.  

---

## Submission Links

- **Live Demo Application:** [https://commercepilot.toolspacehub.com](https://commercepilot.toolspacehub.com)
- **GitHub Repository:** [TO BE ADDED AFTER PUBLICATION]
- **Demonstration Video:** [TO BE ADDED AFTER YOUTUBE PUBLICATION]

---

## Project Overview

### 1. The Problem: The High-Volume Payout Dilemma

Modern digital platforms operate in high-velocity disbursement environments:
- **Affiliate networks** reconciling complex monthly commissions, chargeback clawbacks, and volume tiers.
- **Creator marketplaces** distributing ad revenue and sponsorship shares subject to sudden viral surges.
- **Digital seller platforms** managing multi-vendor settlements with balance thresholds and rolling reserves.
- **Contractor and gig platforms** disbursing frequent earnings with strict velocity and account controls.

Operating teams face a fundamental governance dilemma:
1. **Manual review does not scale:** Auditing hundreds or thousands of routine disbursements each cycle creates immense administrative backlog, delays partner payouts, and causes severe reviewer fatigue where critical fraud or accounting anomalies slip through undetected.
2. **Autonomous AI cannot be trusted with corporate funds:** Handing an LLM or autonomous agent direct API authorization to disburse money is unacceptable. AI models hallucinate, suffer prompt injection, lack numerical consistency, and cannot be held legally or financially liable.

Enterprises are caught between **unscalable manual bureaucracy** and **unacceptable autonomous risk**.

---

### 2. The Solution: ACTOVRA

**ACTOVRA** provides the controlled execution layer between AI decision intelligence and real-world financial settlement.

Instead of letting AI touch money or forcing human operators to review every routine row, ACTOVRA establishes a defense-in-depth architecture:

```
Recipients / Ledger Data
  → Deterministic Integer-Cent Financial Arithmetic
  → Deterministic Policy Mandates (Velocity, Thresholds, Sanctions)
  → AI Anomaly Analysis on Isolated Exceptions Only (NVIDIA NIM)
  → Two-Phase Human Verification Gate (Interactive Checklist + Release)
  → PayPal Sandbox Payouts Execution (Multi-Item Batch Settlement)
  → Item-Level Reconciliation & Immutable Audit Trail
```

**Core Thesis:** AI needs a mandate, not a blank check.  
AI is deployed strictly where it excels—**contextual interpretation and unstructured anomaly explanation**—while deterministic code calculates money and human operators retain exclusive financial disbursement authority.

---

### 3. The Hero Demo: 98.3% Exception Compression

In ACTOVRA's verified demonstration settlement run (*October 2026 Affiliate Settlement*), the platform evaluates **1,000 recipient payout decisions** totaling **$147,930.75**:

| Segment | Decisions | Volume (USD) | Governance Routing |
| :--- | :---: | :---: | :--- |
| **READY BATCH #1** | **917** | **$140,594.47** | Passed 100% of policy mandates; staged for single-click human batch authorization. *(Note: This batch was NOT executed).* |
| **HELD AUTOMATICALLY** | **66** | **$1,834.20** | Positive balances below the $50 minimum threshold; rolled over deterministically. |
| **EXCEPTIONS QUEUE** | **17** | **$5,527.08** | Isolated anomalies requiring human evaluation and AI contextual interpretation. |

#### Exception Compression Workflow Estimate
By deterministically routing 917 clean records to the Ready Batch and automatically holding 66 sub-threshold balances, ACTOVRA achieves **98.3% exception compression** (1,000 decisions compressed to 17 human reviews).

*Illustrative Workflow Comparison:*
- Assuming an operator spends approximately **30 seconds** on each routine manual review, auditing 1,000 decisions would take roughly **8 hours and 20 minutes**.
- Reviewing only the 17 flagged exceptions at the same rate requires roughly **8 minutes and 30 seconds**.
*(Note: This comparison is an illustrative operational workflow estimate based on typical review times, NOT a measured production benchmark).*

---

### 4. Deterministic Financial Layer vs. AI Intelligence

ACTOVRA enforces a strict mathematical and operational boundary between deterministic code and generative AI:

#### Deterministic Ledger Arithmetic (The Sarah Jenkins Case Study)
Sarah Jenkins was flagged by the system for an unusual 3.4× payout surge. Her financial waterfall:
- Gross Earnings: **$512.40**
- Deductions (Refunds): **-$63.70**
- Prior Settlement Adjustment: **-$20.00**
- **Authoritative Balance Payable:** **$428.70**

The **$428.70** payable balance is calculated **100% deterministically** using integer cents. **AI does NOT calculate authoritative payout balances.**

#### AI Role (NVIDIA NIM Nemotron 3.5)
The isolated exception payload is evaluated by **NVIDIA NIM** running `nvidia/nemotron-3.5-lightning-30b-a3b`:
- **Contextual Reasoning:** Explains *why* the surge occurred (viral TikTok campaign driving verified sales conversions).
- **Correlation:** Confirms that refund velocity remained low (1.8%) and no security anomalies exist.
- **Recommendation:** Recommends approving the disbursement subject to standard identity verification.
- **Strict Boundary:** The AI output is validated against strict Zod schemas and stripped of financial privileges. **AI cannot independently authorize financial execution.**

---

### 5. Deterministic Policy Mandates & Human Authority Gate

#### Deterministic Mandates
Before any funds can move, deterministic policy controls enforce rigid operational invariants:
- **Velocity Limit:** Maximum single-cycle payout threshold ($10,000 ceiling).
- **Minimum Disbursement Threshold:** $50 minimum balance (sub-$50 balances roll over automatically).
- **Destination Lock:** Payout address changes within 72 hours trigger a mandatory security hold.
- **Refund Rate Guard:** Disproportionate return ratios (>15%) require clawback reserve review.

#### Human Authority Gate
- **Interactive Checklist:** The approval button remains locked until a human reviewer explicitly checks off the required governance criteria (e.g., verifying marketing attribution, confirmed 2FA callbacks, or agency agreements).
- **Irrevocable Principle:** AI may recommend an action; **only a human can authorize the release of funds.**

---

### 6. PayPal Centrality: Real Financial Settlement Rail

PayPal is central to the ACTOVRA architecture. While ACTOVRA orchestrates governance, policy, and decision intelligence, **PayPal provides the indispensable multi-item financial execution rail and reconciliation backbone**:

#### Real PayPal Sandbox Proof
To prove end-to-end operational viability without touching real fiat capital, ACTOVRA executed a live multi-item disbursement batch via the **PayPal Sandbox Payouts API** (`/v1/payments/payouts`):
- **Batch ID:** `H6YTQ7QCBF4RU`
- **Total Executed:** **$2.00 USD**
- **Payout Items:** **2 payout items ($1.00 each)**
- **Recipient Test Account:** Disbursed to the same designated PayPal Sandbox recipient account (`sb-d4348135261394@personal.example.com`).
- **Batch Status:** `SUCCESS`
- **Total Transaction Fees:** `$0.04 USD` ($0.02 per payout item)
- **Item Transaction IDs:** `8R13661158654483S` and `72D055620M397163M`

#### Item-Level Reconciliation
ACTOVRA records PayPal's batch status, individual item settlement timestamps, unique transaction IDs, and fee deductions into its append-only ledger, closing the loop with an immutable audit trail.

*(Clarification: The 917-recipient Ready Batch totaling $140,594.47 was staged to demonstrate governance controls and was NOT executed).*

---

## Technical Architecture & How We Built It

ACTOVRA is built on a clean separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                   HUMAN AUTHORITY GATE                      │
│        Interactive Verification Checklist & Approval        │
└──────────────────────────────┬──────────────────────────────┘
                               │ unlocks
┌──────────────────────────────▼──────────────────────────────┐
│                    DETERMINISTIC LAYER                      │
│  • Integer-Cent Ledger Arithmetic (Zero Rounding Errors)    │
│  • Pure Policy & Mandate Engine                             │
│  • Finite State Machine Transitions                         │
│  • Event-Sourced SQLite Audit Ledger (Zero External DB Deps)│
└──────────────┬──────────────────────────────┬───────────────┘
               │ context (isolated)           │ authorized batch
┌──────────────▼──────────────┐ ┌─────────────▼───────────────┐
│          AI LAYER           │ │       EXECUTION LAYER       │
│  • NVIDIA NIM Integration   │ │  • PayPal Sandbox Payouts   │
│  • Nemotron 3.5 Lightning   │ │    API (/v1/payments/       │
│  • Zod Validation Schemas   │ │    payouts)                 │
│  • Privilege Stripping Guard│ │  • Item-Level Reconciliation│
└─────────────────────────────┘ └─────────────────────────────┘
```

1. **Deterministic Financial Layer:** Built in TypeScript with integer arithmetic (cents) to eliminate IEEE 754 floating-point inaccuracies. Policy mandates evaluate balances, thresholds, and velocity limits without external network dependencies.
2. **Event-Sourced Store:** An append-only SQLite database (`better-sqlite3`) tracking immutable state transitions (`RECORD_CREATED` → `EVALUATED` → `APPROVED` → `EXECUTED` → `RECONCILED`).
3. **AI Anomaly Agent:** NVIDIA NIM SDK integration invoking `nvidia/nemotron-3.5-lightning-30b-a3b` with structured JSON mode. Output is parsed through strict Zod schemas with privilege stripping that drops any unauthorized financial instructions.
4. **Execution Adapter:** A fully typed, idempotent PayPal Orders/Payouts client implementing OAuth 2.0 client credential authentication, batch creation, and status polling.
5. **Modern Frontend:** Next.js 16 with React 19, CSS modules, and responsive three-column layouts tested across multiple viewport dimensions.

---

## Challenges We Overcame

1. **Defining the Absolute Boundary for AI:** Ensuring generative models never touch authoritative arithmetic. We solved this by calculating all financial balances deterministically *before* passing structured context to NVIDIA NIM.
2. **Preventing Prompt Injection and Hallucinated Actions:** If an LLM recommends "Send $5,000 immediately", our privilege-stripping parser discards the financial directive and keeps the authoritative ledger figure intact.
3. **Achieving Safe Exception Compression:** Compressing 1,000 decisions into 17 reviews without blindly approving risky disbursements required designing multi-layered mandates that capture velocity changes, destination edits, and return rate anomalies.
4. **Demonstrating Real PayPal Settlement Safely:** Orchestrating a live PayPal Sandbox Payouts API call with two $1.00 items in a single batch to prove production-grade API viability, while keeping the larger $140,594.47 staging batch strictly unexecuted.
5. **Truthful End-to-End Provenance:** Tracking every action from data ingestion through AI analysis, checklist verification, PayPal batch ID, and final fees.

---

## Accomplishments That We're Proud Of

- **98.3% Exception Compression:** Validated against a complete 1,000-decision settlement dataset.
- **Mathematical Invariance:** Zero financial drift; all balances calculated deterministically.
- **Real NVIDIA NIM Integration:** Live inference verified with Nemotron 3.5 Lightning 30B.
- **Real PayPal Sandbox Execution:** Batch `H6YTQ7QCBF4RU` executed successfully with item-level transaction IDs.
- **Robust Test Matrix:** **539 automated tests** passing across unit arithmetic, policy gates, and responsive UI components.
- **Judge-Ready Presentation:** Clean 165-second demo video with professional narration and sound design.

---

## What We Learned

- **AI is an Analyst, Not a Bank:** AI excels at synthesizing unstructured context, explaining complex anomalies, and assisting human judgment. Authoritative financial arithmetic and execution gates must remain strictly deterministic.
- **Governance Can Reduce Drag:** True compliance and human-in-the-loop oversight do not require reviewing every routine item. By deterministically verifying clean records, operators can concentrate scrutiny where risk actually lives.
- **Fail-Closed by Design:** When an external AI provider experiences latency or malformed responses, financial platforms must fail closed into a manual review queue rather than halting or guessing.

---

## What's Next for ACTOVRA

- **ERP & Accounting Connectors:** Direct integrations with NetSuite, QuickBooks, and Stripe Billing to ingest live transaction journals.
- **Multi-Rail Execution:** Expanding beyond PayPal Payouts to support ACH, Venmo, and international wire transfers through unified governance gates.
- **Multi-Level Approval Hierarchies:** Configurable dual-authorization workflows for payouts exceeding enterprise risk thresholds ($50,000+).
- **Historical Cohort Modeling:** Long-term anomaly tracking across multiple billing cycles to detect slow-velocity affiliate fraud.

---

## Verified Technology Stack

### Product Runtime & Core Application
- **Frontend & Fullstack Framework:** Next.js 16 (Turbopack, App Router, React 19)
- **Language & Runtime:** TypeScript 5.8, Node.js 24 (`v24.22.1`)
- **Data Validation & Schemas:** Zod 3.24
- **Database & Persistence:** SQLite (`better-sqlite3`), append-only event store
- **Styling:** CSS Modules, SVG iconography

### AI & Intelligence Runtime
- **AI Platform:** NVIDIA NIM (Inference Microservice)
- **Model:** `nvidia/nemotron-3.5-lightning-30b-a3b`
- **Inference Mode:** Contextual anomaly evaluation, structured JSON output, privilege stripping

### Financial Settlement Rail
- **Provider:** PayPal Developer Platform
- **API:** PayPal Sandbox Payouts API (`/v1/payments/payouts`)
- **Authentication:** OAuth 2.0 Token Authentication

### Demo & Video Production Tooling *(Separated from Runtime)*
- **Demo Browser Automation:** Playwright (headless browser recording)
- **Video Assembly & Master Rendering:** FFmpeg 6.1 (1080p / 25 fps H.264)
- **Demo Narration Tool:** Google Gemini 2.5 Pro TTS (Algieba voice). *(Notice: Gemini TTS was utilized solely out-of-band for video narration synthesis and is not part of the ACTOVRA software product).*
- **Soundtrack Bed:** "Future Finance Today" by HigherUniversalMan (Pixabay Asset ID 556753)

---

## Mandatory AI Disclosure

> **AI Disclosure:**  
> ACTOVRA utilizes **NVIDIA NIM** running `nvidia/nemotron-3.5-lightning-30b-a3b` strictly for post-calculation contextual anomaly evaluation, explanation, and recommendations on isolated exceptions.  
> 
> All authoritative financial amounts are calculated deterministically using integer-cent arithmetic. AI is prohibited from computing financial amounts or executing transactions. AI cannot independently authorize financial execution; explicit human authorization is mandatory before any disbursement is submitted to the payment rail.  
> 
> The demonstration video narration was synthesized out-of-band using Google Gemini 2.5 Pro TTS with the Algieba voice as a multimedia production tool; Gemini TTS is not part of the ACTOVRA decision engine or product runtime.
