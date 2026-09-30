---
status: accepted
---

# Gate completion on evidence and treat improvements as candidates

Helm will model Task, Session, Run, Turn, and Step separately; persist recoverable state and explicit terminal outcomes; allow one active Run per Session; and place uncertain side effects in needs_reconciliation. Coding and office tasks use different verifiers, and incomplete evidence is UNKNOWN rather than success. P0 records session/workspace notes and Experience Candidates but never mutates production Skills, Memory, or Harness behavior automatically. This keeps recovery, acceptance, and future improvement attributable and reversible.

The alternative was a chat-first loop that trusts the model’s completion statement and writes successful traces directly into memory or policy. That path is simpler to demo but cannot distinguish a plausible response from a verified delivery, and it makes failures and policy drift difficult to replay or roll back.
