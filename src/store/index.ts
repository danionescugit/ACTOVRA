import { CommerceOperationEvent } from '../domain/events';
import { createInitialOperation, transitionOperation, type CommerceOperation } from '../domain/stateMachine';

/**
 * In-memory store for commerce operations and their audit trails.
 * This is a demo implementation for the hackathon project.
 */
export class CommerceStore {
  private operations = new Map<string, {
    operationId: string;
    opportunityId: string;
    initialTimestamp: Date;
    events: { event: CommerceOperationEvent; timestamp: Date }[];
  }>();

  /**
   * Start tracking a new commerce operation.
   * @param operationId Unique identifier for the commerce operation
   * @param opportunityId Identifier of the opportunity that triggered this operation
   * @param initialTimestamp Timestamp when the operation was created
   */
  startOperation(operationId: string, opportunityId: string, initialTimestamp: Date): void {
    if (this.operations.has(operationId)) {
      throw new Error(`Operation with ID ${operationId} already exists`);
    }
    this.operations.set(operationId, {
      operationId,
      opportunityId,
      initialTimestamp,
      events: []
    });
  }

  /**
   * Record an event for an operation as part of the audit trail.
   * @param operationId The operation to record the event for
   * @param event The event that occurred
   * @param timestamp The timestamp when the event occurred (used for state transition)
   */
  recordEvent(operationId: string, event: CommerceOperationEvent, timestamp: Date): void {
    const op = this.operations.get(operationId);
    if (!op) {
      throw new Error(`Operation with ID ${operationId} not found`);
    }
    op.events.push({ event, timestamp });
  }

  /**
   * Get the current state of an operation by replaying all recorded events.
   * @param operationId The operation to get the state for
   * @returns The current commerce operation state, or undefined if not found
   */
  getOperationState(operationId: string): CommerceOperation | undefined {
    const op = this.operations.get(operationId);
    if (!op) {
      return undefined;
    }

    // Replay events to get current state
    let current = createInitialOperation(
      { id: op.opportunityId },
      op.operationId,
      op.initialTimestamp
    );

    for (const { event, timestamp } of op.events) {
      current = transitionOperation(current, event, timestamp);
    }

    return current;
  }

  /**
   * Get the audit trail (list of events with timestamps) for an operation.
   * @param operationId The operation to get the audit trail for
   * @returns Array of events with their timestamps, or undefined if not found
   */
  getAuditTrail(operationId: string): Array<{ event: CommerceOperationEvent; timestamp: Date }> | undefined {
    const op = this.operations.get(operationId);
    if (!op) {
      return undefined;
    }
    // Return a copy to prevent external modification
    return [...op.events];
  }

  /**
   * Check if an operation exists in the store.
   * @param operationId The operation to check
   * @returns true if the operation exists
   */
  hasOperation(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  /**
   * Remove an operation from the store (for cleanup in tests).
   * @param operationId The operation to remove
   */
  removeOperation(operationId: string): void {
    this.operations.delete(operationId);
  }
}

/**
 * Default store instance for use throughout the application.
 * In a production system, this might be replaced with a persistent storage implementation.
 */
export const commerceStore = new CommerceStore();