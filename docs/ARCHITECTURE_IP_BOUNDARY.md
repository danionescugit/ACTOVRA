# CommercePilot — Architecture & IP Boundary

Status: Task 10, Checkpoint 2 (CP2) · 2026-10-22

This document records (1) what is **open source as part of the hackathon
submission** and (2) what is deliberately **out of scope, reserved for a
possible future proprietary product** ("Revenue Intelligence"). It exists so
contributors and reviewers can see the boundary without ambiguity. There is
intentionally **no LICENSE file** in this repository — licensing is a later,
explicit decision and this document does not grant or imply one.

## 1. Open-source scope (hackathon submission)

Everything currently in this repository is the open hackathon artifact:

| Area | Location | Content |
| --- | --- | --- |
| Domain model | `src/domain/` | Synthetic opportunity catalog, `CommerceDecision`/`PolicyResult`/`PaymentResult` schemas, the 14 sanctioned operation events, and the pure state machine (including capture-integrity guards). |
| Deterministic policy engine | `src/policy/` | Pure `evaluatePolicy` + the synthetic policy configuration (AI proposes → policy decides). |
| Agents (proposal boundary) | `src/agents/` | `CommerceAgent` (AI proposes, never decides) + the `LLMProvider` interface and an NVIDIA implementation. |
| PayPal boundary | `src/services/paypal/` | Typed PayPal Orders v2 adapter: OAuth, create-order (incl. redirect approval flow), capture, get-order, deterministic money parsing, secret-free errors. |
| Durable store | `src/store/` | Event-sourced `CommerceOperationStore` on `node:sqlite` (single-writer `BEGIN IMMEDIATE` transactions, append-only audit). Zero npm dependencies. |
| Orchestrators | `src/orchestrator/` | Execution (durable claim → exactly one createOrder) and capture (provider verification gate → single-flight capture → reconciliation). |
| Application boundary | `src/server/`, `src/config/` | Composition root, app configuration, and the application-service use cases that own all event application (routes must not apply arbitrary domain events directly). |

All of the above runs on **synthetic data only**: opportunities are hardcoded
(`src/domain/data.ts`), decisions are deterministic or LLM-proposed against
those synthetic opportunities, and no real customer, merchant, or transaction
data exists anywhere in the repository.

## 2. Future proprietary scope ("Revenue Intelligence")

The following are explicitly **not part of this repository** and are reserved
for a possible future commercial product:

- **Revenue discovery and analytics**: mining real commerce/transaction data
  for monetization opportunities, propensity modeling, revenue forecasting,
  cohort analysis, and similar intelligence features.
- **Production opportunity catalogs**: any non-synthetic source of
  opportunities (merchant feeds, marketplace data, partner APIs).
- **Trained models, prompts-as-products, embeddings, and datasets** derived
  from real transaction data.
- **Operational tooling** for multi-tenant deployment, billing, and
  administration of a commercial service.

Nothing in this repository reads, stores, or transmits data that would fall
into these categories; the synthetic-only discipline in section 1 is what
keeps the boundary clean.

## 3. Boundary rules for contributors

1. Keep discovery **synthetic** in this repo. If a feature needs real-world
   commerce data, it belongs to the future product, not here.
2. Keep the **event-application authority** inside the application boundary
   (`src/server/commercePilotApp.ts`). Route handlers (CP3/CP4) consume use
   cases; they never construct or apply raw domain events.
3. Keep provider integrations behind typed boundaries
   (`src/services/paypal/`, `src/agents/`) — no raw fetch calls elsewhere.
4. Never commit secrets (`.env` is gitignored; `.env.example` carries
   non-secret names only) and never log credential values.
5. This document is **not a license**. Adding or changing a license is a
   separate, explicit decision.
