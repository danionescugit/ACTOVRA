/**
 * Interface for LLM providers that can generate structured commerce decisions.
 */
export interface LLMProvider {
  /**
   * Generate a structured commerce decision from the given prompt.
   * @param prompt The prompt to send to the LLM.
   * @returns A promise that resolves to the generated JSON string.
   * @throws If there is an error in the provider (network, API error, etc.).
   */
  generateStructuredDecision(prompt: string): Promise<string>;
}