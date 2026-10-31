import { LLMProvider } from './provider';

/**
 * NVIDIA implementation of the LLMProvider using OpenAI-compatible API.
 */
export class NVIDIAProvider implements LLMProvider {
  private apiKey: string;
  private apiBase: string;
  private model: string;

  constructor(apiKey: string, apiBase: string = 'https://integrate.api.nvidia.com/v1', model: string = 'nvidia/nemotron-3.5-lightning-30b-a3b') {
    if (!apiKey) {
      throw new Error('NVIDIA_API_KEY is required');
    }
    this.apiKey = apiKey;
    this.apiBase = apiBase;
    this.model = model;
  }

  async generateStructuredDecision(prompt: string): Promise<string> {
    const url = `${this.apiBase}/chat/completions`;
    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that outputs only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, // low temperature for deterministic output
      max_tokens: 4096,
      stream: false,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`NVIDIA API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`Empty content returned by model (finish_reason: ${data.choices?.[0]?.finish_reason})`);
    }
    return content;
  }
}