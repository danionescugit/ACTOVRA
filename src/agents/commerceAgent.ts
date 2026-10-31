import { LLMProvider } from './provider';
import { NVIDIAProvider } from './nvidiaProvider';
import { CommerceDecisionSchema, type CommerceDecision } from '../domain/schemas';

/**
 * Error types for the AI Commerce Agent
 */
export class CommerceAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommerceAgentError';
  }
}

export class ProviderError extends CommerceAgentError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ValidationError extends CommerceAgentError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends CommerceAgentError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Result type for agent operations
 */
export type CommerceAgentResult =
  | { success: true; decision: CommerceDecision }
  | {
      success: false;
      error: ProviderError | ValidationError | ConfigurationError;
    };

/**
 * AI Commerce Agent that proposes commerce decisions using an LLM provider.
 * It does NOT invoke policy evaluation - that is a separate concern.
 */
export class CommerceAgent {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  /**
   * Generate a commerce decision from an opportunity and business context.
   * @param opportunityId The ID of the opportunity to act on
   * @param businessContext Synthetic business context/policies (for demo)
   * @returns Promise resolving to the result
   */
  async proposeDecision(
    opportunityId: string,
    businessContext: string
  ): Promise<CommerceAgentResult> {
    try {
      // Construct the prompt
      const prompt = this.buildPrompt(opportunityId, businessContext);

      // Get raw response from provider
      const rawResponse = await this.provider.generateStructuredDecision(prompt);

      // Parse and validate the response
      const decision = this.validateAndParseResponse(rawResponse, opportunityId);

      return {
        success: true,
        decision: {
          ...decision,
          provenance: 'REAL_AI',
        },
      };
    } catch (error) {
      if (error instanceof ProviderError || error instanceof ValidationError || error instanceof ConfigurationError) {
        return { success: false, error };
      }
      // Wrap unexpected errors
      return {
        success: false,
        error: new ProviderError(
          error instanceof Error ? error.message : 'Unknown error in commerce agent'
        ),
      };
    }
  }

  /**
   * Build the prompt for the LLM.
   * This is where we encode the architectural principle: AI proposes, policy decides.
   */
  private buildPrompt(opportunityId: string, businessContext: string): string {
    return `
You are an AI commerce decision proposer. Your ONLY job is to propose a commerce decision based on the given opportunity and business context.

IMPORTANT RULES:
- You MUST NOT attempt to approve, execute, or override any policy
- You MUST NOT decide that human approval can be skipped
- You MUST NOT mutate policy configuration or approval state
- You MUST ONLY return a proposed CommerceDecision
- Amounts must be in integer minor units (cents)
- You must use the exact opportunity ID provided: ${opportunityId}
- You must not invent a different opportunity ID

Business Context (synthetic/demo):
${businessContext}

Opportunity ID: ${opportunityId}

Return ONLY a valid JSON object matching this structure exactly:
{
  "opportunityId": "string (must match the provided opportunity ID)",
  "action": "CREATE_PAYMENT | REFUND | UPDATE_SUBSCRIPTION | CREATE_INVOICE",
  "amount": integer (positive, in cents),
  "currency": "USD | EUR | GBP | JPY | CAD",
  "recipient": "string (non-empty)",
  "justification": "string (non-empty, explaining why this action is proposed)"
}

Do not include any other fields. Do not include explanations outside the JSON.
Do not add policy-related fields like "approvedByPolicy" or "humanApprovalRequired".
Your output will be validated by a deterministic policy engine that decides whether the proposal may advance.
`.trim();
  }

  /**
   * Parse and validate the LLM response against the CommerceDecision schema.
   * Throws ValidationError if validation fails.
   */
  private validateAndParseResponse(rawResponse: string, expectedOpportunityId: string): CommerceDecision {
    let parsed: unknown;
    try {
      let cleaned = rawResponse.trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleaned = jsonMatch[0];
      }
      parsed = JSON.parse(cleaned);
    } catch {
      throw new ValidationError(
        `Failed to parse LLM response as JSON: ${rawResponse.substring(0, 100)}...`
      );
    }

    // Validate against Zod schema
    const result = CommerceDecisionSchema.safeParse(parsed);
    if (result.success) {
      // Additional opportunity ID check: ensure it matches what we sent in the prompt
      // Note: We can't enforce this strictly because the prompt doesn't contain the exact ID in a parsable way,
      // but we can check if the returned ID is a non-empty string.
      // For demo purposes, we'll rely on the schema validation and note that the prompt instructed to use the provided ID.
      if (result.data.opportunityId !== expectedOpportunityId) {
        throw new ValidationError(
          `LLM response opportunityId does not match the requested opportunity`
        );
      }
      return result.data;
    } else {
      // Format Zod errors for better debugging
      const errors = result.error.issues
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('; ');
      throw new ValidationError(
        `LLM response failed validation: ${errors}. Response: ${JSON.stringify(parsed).substring(0, 200)}...`
      );
    }
  }

  /**
   * Create a CommerceAgent with NVIDIA provider using environment variables.
   * Throws ConfigurationError if required environment variables are missing.
   */
  static createWithNVIDIAFromEnv(): CommerceAgent {
    const apiKey = process.env.NVIDIA_API_KEY;
    const apiBase = process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1';
    const model = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';

    if (!apiKey) {
      throw new ConfigurationError(
        'NVIDIA_API_KEY environment variable is required but not set. Check your .env.local file.'
      );
    }

    const provider = new NVIDIAProvider(apiKey, apiBase, model);
    return new CommerceAgent(provider);
  }
}