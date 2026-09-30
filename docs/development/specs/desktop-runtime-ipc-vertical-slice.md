## Problem Statement

The desktop application currently presents a conversation-shaped mock interface, but it is not connected to the Runtime. Sending a message only clears the composer, progress is simulated locally, and approval changes presentation state without approving a concrete action. The Electron main process exposes placeholder IPC handlers, so a user cannot submit a task and observe the real Task → Session → Run → Verification lifecycle that is already available to the CLI and Runtime tests.

This makes the desktop surface unable to prove the architecture's most important promise: the desktop and CLI use the same Runtime semantics for local tasks, policy, execution, events, and verification.

## Solution

Connect the existing Electron Renderer and preload bridge to a Runtime-owned first vertical slice. The Electron main process will compose a RuntimeFacade with an InMemoryEventStore and deterministic MockProvider, validate typed requests, start and control Runs, and forward ordered Runtime events. The Renderer will submit user messages through preload, derive its conversation and execution-card state from those events, and render the resulting assistant output and verification outcome.

The slice will exercise the existing ToolPolicy boundary for deterministic approval fixtures: deny prevents execution, ask pauses the Run for a decision, and an approved proposal resumes the same Run. It will preserve the current conversation-first desktop layout while removing timer-driven execution claims. SQLite persistence, real provider credentials, and real file or shell tools remain later slices.

## User Stories

1. As a desktop user, I want to submit a message from the center composer, so that a Runtime Task, Session, and Run are created.
2. As a desktop user, I want my submitted message to appear in the conversation, so that I can distinguish my request from generated output.
3. As a desktop user, I want the assistant response to arrive from Runtime events, so that the conversation reflects actual execution.
4. As a desktop user, I want the execution card to show the Run lifecycle, so that I can see whether the task is deciding, validating, executing, reducing, verifying, paused, failed, or complete.
5. As a desktop user, I want the execution card to show the active Run id and step information, so that I can relate visible progress to a specific operation.
6. As a desktop user, I want the UI to show budget or limit failures as an explicit Run result, so that a bounded failure is not mistaken for success.
7. As a desktop user, I want a pending approval to name the proposed tool, action, and workspace scope, so that I can make an informed decision.
8. As a desktop user, I want to deny an approval, so that the proposed executor is not called and the Run records a denied outcome.
9. As a desktop user, I want to approve an allowed proposal, so that the same Run continues through the existing proposal rather than silently creating a different request.
10. As a desktop user, I want approval decisions to be tied to one concrete action and scope, so that an approval cannot accidentally authorize unrelated work.
11. As a desktop user, I want to pause a Run, so that I can stop progress before another step is started.
12. As a desktop user, I want to resume a paused Run, so that I can continue the same task without losing its event history.
13. As a desktop user, I want to cancel a Run, so that no new execution action is appended after cancellation.
14. As a desktop user, I want a failed provider call to be visible as a failed Run, so that transient or configuration errors are not hidden behind a generic chat message.
15. As a desktop user, I want verification to be shown separately from the assistant text, so that non-empty output is not confused with proof that a task succeeded.
16. As a desktop user, I want unknown verification or side-effect results to stop for reconciliation, so that uncertain work is not presented as completed.
17. As a desktop user, I want the UI to show a useful error without exposing API keys, authorization headers, or private file contents.
18. As a desktop user, I want to reconnect or refresh the view while a main-process Run remains alive, so that the UI can rebuild from an ordered event snapshot.
19. As a desktop user, I want duplicate or out-of-order events to be ignored safely, so that messages and progress do not appear twice or regress.
20. As a desktop user, I want the selected workspace and session context to be carried into the Run, so that the task is associated with the place where I started it.
21. As a desktop user, I want a second submit while a Run is active to be handled explicitly, so that accidental duplicate Runs do not race without feedback.
22. As a desktop user, I want the conversation to remain centered on the request and response, so that detailed execution evidence can stay embedded or collapsed instead of replacing the chat.
23. As a desktop user, I want the right-hand area to expose approval and verification evidence, so that decisions and outcomes are reviewable without leaving the conversation.
24. As a CLI user, I want the desktop Run to use the same Runtime state and policy semantics as CLI runs, so that behavior does not depend on the surface.
25. As a maintainer, I want a typed preload contract, so that the Renderer cannot invoke arbitrary Node.js, filesystem, shell, or credential APIs.
26. As a maintainer, I want the main process to validate request shapes and workspace/session identifiers, so that malformed or cross-session requests fail before reaching Runtime.
27. As a maintainer, I want Runtime to remain the owner of Task, Session, Run, policy, execution, and verification semantics, so that the UI cannot bypass safety boundaries.
28. As a maintainer, I want every forwarded event to include a Run identity and monotonic sequence, so that the Renderer can isolate sessions and deduplicate updates.
29. As a maintainer, I want an event replay or backfill request, so that reconnecting the Renderer does not require re-running the model.
30. As a maintainer, I want approval decisions and control commands to be idempotent, so that retries do not execute an action twice.
31. As a maintainer, I want provider and Runtime failures normalized at the IPC boundary, so that renderer-visible errors are stable and do not contain secrets.
32. As a maintainer, I want deterministic MockProvider behavior in the vertical slice, so that Desktop IPC smoke tests are repeatable and do not depend on network access.
33. As a maintainer, I want the existing RuntimeFacade behavior tests to remain passing, so that the new desktop seam does not replace lower-level safety coverage.
34. As a maintainer, I want the static timer and local approval demo behavior removed from the active path, so that the interface cannot claim that a fake Run is real.
35. As a maintainer, I want the first slice to use in-memory state explicitly, so that restart durability is not implied before SQLite recovery is implemented.

## Implementation Decisions

- The first deliverable is one deterministic Desktop IPC vertical slice: Renderer input → typed preload → Electron main → RuntimeFacade → MockProvider/Runtime events → Renderer conversation and verification state.
- The Electron main process composes the Runtime dependencies. The Renderer owns presentation and local reducer state only; it does not import Runtime internals or perform local task execution.
- The preload API exposes narrow request/response methods for starting a Run, querying or replaying a Run, controlling a Run, resolving an approval, and subscribing to Run events. Request, response, error, and event payloads are typed.
- The current RuntimeFacade does not yet expose approval events or an approval-resolution API. The slice must add a supported Runtime/public composition boundary for the pending proposal and decision; it must not expose the event store directly to the Renderer or treat the current static approval handler as a completed implementation.
- Every event envelope contains the Run identity, a monotonic sequence, an event type, and a sanitized payload. The Renderer applies events idempotently and ignores events for another Run or an already-seen sequence.
- A reconnect or view refresh requests a snapshot/backfill from the main process and rebuilds the visible state without invoking the provider again.
- Main-process validation rejects malformed requests, unknown workspace/session context, invalid control transitions, and approval decisions that do not match the pending action and scope.
- Runtime remains the only owner of state transitions, ToolPolicy, ToolExecutor invocation, budget checks, side-effect receipts, and Verification. UI controls dispatch commands; they do not mutate authoritative Run state.
- Runtime keeps the default-deny and fail-closed behavior. The approval fixture follows the existing policy boundary: `allow` reaches the executor, `deny` does not, and `ask` produces a pending approval state bound to the original tool call, parameters, and scope. An approved `ask` proposal resumes the original Run and preserves its event history.
- The vertical slice uses InMemoryEventStore and a deterministic MockProvider. It does not introduce a native database binding, network call, keychain lookup, or persistent approval store.
- The desktop layout remains conversation-first: the center column renders messages and an embedded or collapsible execution card; the right column renders approvals, artifacts placeholders, and verification evidence.
- Renderer-visible errors are normalized and sanitized. API keys, authorization headers, private file content, and raw provider diagnostics are excluded from IPC events and UI state.
- The slice allows one active Run per Session. Duplicate start, control, approval, and replay requests return a stable result and do not create a second execution path.
- Cancellation is defined at a supported command boundary: once a Run is terminal, no new tool action may be appended. If an in-flight provider or executor cannot be interrupted in this slice, its eventual callback is reconciled against ledger order and cannot move a cancelled Run back to execution; the implementation must not claim hard interruption.
- The CLI remains a separate caller of the same Runtime interfaces. No HTTP backend is added for this local-only slice.
- Existing RuntimeFacade and Provider contract behavior remains the supporting contract; the new primary contract is the public Desktop IPC boundary.

## Testing Decisions

- The primary seam is a Desktop IPC smoke test using the actual public preload/Main composition with a deterministic MockProvider. This was confirmed by the user after reviewing the proposed seams.
- The smoke test submits a task through the public desktop bridge and asserts external behavior: Task/Session/Run creation, ordered event delivery, assistant output, execution-card state, and verification result.
- The smoke test covers allow, deny, and ask/approve flows. It asserts that denial does not call the executor, approval resumes the same Run, and repeated approval or control commands do not execute twice.
- The smoke test covers pause, resume, cancel, duplicate submission, provider failure, verification unknown, budget failure, and reconnect/backfill behavior where each is exposed through the public bridge.
- The smoke test covers unknown side-effect receipts entering `needs_reconciliation`, and cancellation interleaved with an in-flight provider or executor callback. It asserts ledger-order semantics and that a terminal Run does not append a new tool action.
- Event assertions use Run identity and sequence, and verify that duplicate or unrelated events do not alter the visible state. Tests should observe rendered state or bridge results rather than private reducers or Electron implementation details.
- The existing RuntimeFacade behavior suite remains required supporting coverage for state transitions, event replay, policy denial, executor failure, reconciliation, and metadata recovery. It is not replaced by the Desktop IPC test.
- The existing Provider contract tests remain required for request mapping, text and usage mapping, tool-call mapping, and HTTP error classification. They continue to use local fake transport.
- A browser-only Vite preview is not evidence for IPC behavior. The smoke test must run against the Electron main/preload boundary or an equivalent public composition that exercises the same contract.
- Verification commands for the slice are `pnpm build`, `pnpm test`, `pnpm typecheck`, the Desktop IPC smoke test, and the existing CLI smoke. Results must distinguish deterministic mock coverage from real provider or real task execution.

## Out of Scope

- Real DeepSeek, Zhipu, or Kimi requests, streaming, model selection UI, API-key storage, Keychain integration, provider retries, or network cancellation.
- SQLite native persistence, migrations, process-exit recovery, checkpoint export, cross-process locking, and durable pending approvals.
- Actual filesystem, shell, Git, browser, or office tools; path guards; sandbox integration; worktree management; and unknown-side-effect reconciliation UI beyond the event state needed for the fixture.
- DOCX, XLSX, and PDF worker integration, OCR, artifact storage, diff rendering, and file-content verification.
- Production-grade approval policy management, multi-user identity, remote HTTP services, external writes, multi-agent orchestration, reviewer flows, or A2A networking.
- Packaging, auto-update, cross-platform distribution, mobile clients, and a separate hosted backend.

## Further Notes

- The repository now implements the Desktop IPC → Runtime → MockProvider slice described here. The implementation remains intentionally local and in-memory; this specification does not claim real provider, real tool, or restart durability.
- The architecture uses logical front/back separation inside one local desktop product: React Renderer is the front end, Electron main and Runtime are the local back end, and preload/IPC is the narrow boundary between them.
- Completion evidence must update implementation status and distinguish Desktop IPC smoke, Runtime behavior tests, Provider contract tests, CLI smoke, and any checks that remain mock-only.
- Setup is complete: Helm uses GitHub Issues with the default triage vocabulary. The implementation tickets are published as [#1](https://github.com/KG2013/Helm/issues/1), [#2](https://github.com/KG2013/Helm/issues/2), [#3](https://github.com/KG2013/Helm/issues/3), and [#4](https://github.com/KG2013/Helm/issues/4); #1 and #2 are closed after verification, and #3/#4 are the approval and failure-state slices covered by the current implementation.
