import type { Verifier, VerifierInput, Verification } from './types.js';

/** A deterministic P0 verifier for the provider-neutral text loop. */
export class TextOutputVerifier implements Verifier {
  readonly id = 'text-output-v1';

  async verify(input: VerifierInput): Promise<Verification> {
    const output = input.output.trim();
    if (!output) {
      return {
        result: 'unknown',
        verifier: this.id,
        message: 'No final output was produced.',
        evidence: [{ type: 'text', summary: 'Final output was empty.' }],
      };
    }
    return {
      result: 'passed',
      verifier: this.id,
      message: 'A non-empty final output was produced by the run.',
      evidence: [{ type: 'text', summary: `Final output length: ${output.length} characters.` }],
    };
  }
}
