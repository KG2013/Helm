import type { DomainEvent, Evidence, Verifier, VerifierInput, Verification } from './types.js';

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

export class WorkspaceInspectVerifier implements Verifier {
  readonly id = 'workspace-inspect-v1';

  async verify(input: VerifierInput): Promise<Verification> {
    const receipt = [...input.context]
      .reverse()
      .find((event) => event.type === 'tool.receipt' && isSuccessfulInspectionReceipt(event));
    const payload = receipt?.payload as { receipt?: { artifact?: { type?: string; uri?: string; hash?: string } } } | undefined;
    const artifact = payload?.receipt?.artifact;
    if (!input.output.trim() || !artifact?.uri || !artifact.hash) {
      return { result: 'unknown', verifier: this.id, evidence: [], message: 'Workspace inspection has no verifiable artifact receipt.' };
    }
    const evidence: Evidence = {
      type: artifact.type ?? 'workspace-inspection',
      summary: 'Workspace metadata inspection receipt',
      uri: artifact.uri,
      hash: artifact.hash,
    };
    return { result: 'passed', verifier: this.id, evidence: [evidence], message: 'Workspace inspection receipt is present.' };
  }
}

function isSuccessfulInspectionReceipt(event: DomainEvent): boolean {
  const payload = event.payload as { ok?: boolean; receipt?: { profile?: string; artifact?: { type?: string; uri?: string; hash?: string } } };
  return payload.ok === true
    && payload.receipt?.profile === 'workspace.inspect@v1'
    && payload.receipt.artifact?.type === 'workspace-inspection'
    && payload.receipt.artifact.uri?.startsWith('workspace://') === true
    && /^[a-f0-9]{64}$/.test(payload.receipt.artifact.hash ?? '');
}
