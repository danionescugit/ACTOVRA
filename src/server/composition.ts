/**
 * CommercePilot server-side composition root (Task 10, CP2-D).
 *
 * The ONE place where concrete implementations are wired together:
 *
 *   AppConfig ──→ openStoreDb ──→ CommerceOperationStore
 *   PayPalConfig (env) ──→ PayPalService ──┐
 *   AppConfig.redirect ──→ approvalRedirect│→ CommerceExecutionOrchestrator
 *                                          └→ CaptureOrchestrator
 *
 * Discipline:
 * - SERVER ONLY. This module and everything it pulls in (node:sqlite, PayPal
 *   credentials) must never be imported by client components. There is no
 *   `server-only` dependency in this project, so the convention is enforced
 *   by placement (src/server/) and this contract note.
 * - NO side effects at import time. Construction happens lazily, on first
 *   getCommercePilotComposition() call, and construction itself performs ZERO
 *   network calls: PayPalService only captures its config; tokens/orders are
 *   fetched per-call by the orchestrators.
 * - loadPayPalConfigFromEnv() (which requires PAYPAL_CLIENT_ID/SECRET) is
 *   called lazily INSIDE construction — never at module import — so merely
 *   importing this module never throws for missing credentials.
 * - Failure semantics: construction errors (missing credentials, invalid
 *   config, unwritable DB path) are configuration errors thrown once from
 *   the first composition call; see resetCommercePilotCompositionForTests()
 *   for test isolation.
 * - No UI, no API routes here (CP3/CP4 will consume this root).
 */

import {
  CommerceExecutionOrchestrator,
  CaptureOrchestrator,
  type PayPalApprovalRedirect,
} from '../orchestrator';
import {
  PayPalService,
  loadPayPalConfigFromEnv,
  type PayPalConfig,
} from '../services/paypal';
import { CommerceOperationStore } from '../store';
import { openStoreDb, type StoreDb } from '../store/db';
import { loadAppConfigFromEnv, type AppConfig } from '../config/appConfig';
import { CommercePilotApplication } from './commercePilotApp';
import { HybridCommerceDecisionProposer } from './hybridDecisionProposer';
import { type DecisionProposer, SyntheticDecisionProposer } from './syntheticDecisionProposer';
import { CommerceAgent } from '../agents/commerceAgent';

/**
 * Fully wired application composition. Every field is ready to use; `close()`
 * releases the durable store handle.
 */
export interface CommercePilotComposition {
  /** Non-secret application configuration (paths + derived redirect URLs). */
  readonly config: AppConfig;
  /** The underlying store database handle (closable, WAL-backed file DB). */
  readonly storeDb: StoreDb;
  /** Durable commerce operation store (event-sourced, append-only audit). */
  readonly store: CommerceOperationStore;
  /** PayPal Orders API boundary (constructed eagerly; performs no I/O here). */
  readonly paypal: PayPalService;
  /** Execution orchestrator: APPROVED → createOrder → PAYPAL_ORDER_CREATED. */
  readonly execution: CommerceExecutionOrchestrator;
  /** Capture orchestrator: provider-verified capture + reconciliation. */
  readonly capture: CaptureOrchestrator;
  /** Decision proposer: live AI agent with synthetic fallback. */
  readonly decisionProposer: DecisionProposer;
  /** Named application use cases consumed by HTTP adapters. */
  readonly application: CommercePilotApplication;
  /** Close the store database handle. Idempotent per handle semantics. */
  close(): void;
}

/** Options for createCommercePilotComposition (all optional; env defaults). */
export interface CommercePilotCompositionOptions {
  /** Explicit app config; when omitted, loadAppConfigFromEnv() is used. */
  readonly appConfig?: AppConfig;
  /** Explicit PayPal config; when omitted, loadPayPalConfigFromEnv() is used. */
  readonly paypalConfig?: PayPalConfig;
  /** Explicit decision proposer; when omitted, HybridCommerceDecisionProposer is used. */
  readonly decisionProposer?: DecisionProposer;
}

/** Construct a fully wired composition from explicit or env-derived config. */
export function createCommercePilotComposition(
  options: CommercePilotCompositionOptions = {}
): CommercePilotComposition {
  const config = options.appConfig ?? loadAppConfigFromEnv();
  const storeDb = openStoreDb(config.dbPath);

  let paypalConfig: PayPalConfig;
  try {
    // Lazily invoked here — inside construction, never at module import — so
    // importing this module never reads PayPal credentials or throws for them.
    paypalConfig = options.paypalConfig ?? loadPayPalConfigFromEnv();
  } catch (error) {
    storeDb.close();
    throw error;
  }

  const store = new CommerceOperationStore({ db: storeDb.db });
  const paypal = new PayPalService({ config: paypalConfig });

  const approvalRedirect: PayPalApprovalRedirect = {
    returnUrl: config.paypalReturnUrl,
    cancelUrl: config.paypalCancelUrl,
  };

  const execution = new CommerceExecutionOrchestrator({
    store,
    paypal,
    approvalRedirect,
  });
  const capture = new CaptureOrchestrator({ store, paypal });

  let decisionProposer: DecisionProposer;
  if (options.decisionProposer !== undefined) {
    decisionProposer = options.decisionProposer;
  } else if (process.env.ENABLE_REAL_AI === '1' || (!process.env.VITEST && process.env.NVIDIA_API_KEY)) {
    let agent: CommerceAgent | null = null;
    try {
      if (process.env.NVIDIA_API_KEY) {
        agent = CommerceAgent.createWithNVIDIAFromEnv();
      }
    } catch {
      agent = null;
    }
    decisionProposer = new HybridCommerceDecisionProposer(agent);
  } else {
    decisionProposer = new SyntheticDecisionProposer();
  }

  const application = new CommercePilotApplication({
    store,
    execution,
    capture,
    decisionProposer,
  });

  return {
    config,
    storeDb,
    store,
    paypal,
    execution,
    capture,
    decisionProposer,
    application,
    close: () => storeDb.close(),
  };
}

/* ------------------------------------------------------------------ */
/* Lazy process-wide singleton                                         */
/* ------------------------------------------------------------------ */

let singleton: CommercePilotComposition | undefined;

/**
 * Return the process-wide composition, constructing it on first use.
 * Deliberately lazy: importing this module has NO side effects, and the
 * PayPal env read (credential requirement) happens only when the app actually
 * requests the composition.
 *
 * @throws AppConfigurationError / PayPalConfigurationError from the FIRST
 *   call when environment configuration is missing or invalid.
 */
export function getCommercePilotComposition(): CommercePilotComposition {
  if (singleton === undefined) {
    singleton = createCommercePilotComposition();
  }
  return singleton;
}

/**
 * Test isolation hook: forget the singleton so the next
 * getCommercePilotComposition() rebuilds from the current environment.
 * Never call this from application code.
 */
export function resetCommercePilotCompositionForTests(): void {
  if (singleton !== undefined) {
    try {
      singleton.close();
    } catch {
      // A already-closed handle must not mask the reset itself.
    }
  }
  singleton = undefined;
}
