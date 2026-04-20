---
name: self-hosted-call-orchestrator
description: Design, extend, and debug self-hosted outbound calling systems that use backend orchestration, Android workers with physical SIMs, callback-based human derivation, and later migration paths to PBX or GSM gateways. Use when Codex needs to plan or implement campaign queues, worker assignment, call result state machines, callback escalation, dashboard operations, or migration from Android-line workers to self-hosted PBX infrastructure.
---

# Self Hosted Call Orchestrator

## Overview

Use this skill to build or evolve outbound calling systems where the application owns orchestration and uses local telephony resources such as Android phones with SIMs or a self-hosted PBX. Prefer it when the objective is operational reliability, queue control, callback derivation, and migration planning without Twilio-style hosted telephony.

## Workflow

1. Identify the telephony edge:
- Android workers with SIMs
- PBX with trunk or GSM gateway
- mixed transition architecture

2. Model four state layers separately:
- worker state
- call state
- contact/campaign state
- callback/derivation state

3. Keep V1 simple:
- one active outbound contact at a time per queue
- callback derivation instead of live transfer
- explicit result states

4. Add operator visibility in the dashboard:
- connected workers
- active worker
- active contact
- campaign counters
- callback queue

5. Only introduce PBX live transfer after callback derivation is stable.

## Implementation Rules

- Treat Android devices as line workers, not as the source of truth. The backend owns assignment, queue progression, and result state.
- Persist campaign and callback state server-side. Do not rely on browser-only state for queue control.
- Keep worker assignment deterministic: prefer an idle connected worker; fall back to round-robin among available workers.
- When a call ends without an explicit disposition, mark the contact as `sin_respuesta` or another explicit failure state. Never leave contacts in ambiguous in-call states.
- For V1 human derivation, capture:
  - callback reason
  - assigned advisor
  - transcript summary if available
- Separate transport events from business decisions. Socket events update worker/call state; campaign logic decides next contact or callback behavior.
- Preserve a migration path to PBX by keeping orchestration interfaces abstract: `select worker`, `start call`, `end call`, `mark result`, `enqueue callback`.

## References

- For architecture patterns and migration paths, read [references/architecture.md](./references/architecture.md).
- For the shared state model, read [references/state-model.md](./references/state-model.md).
- For phased rollout guidance, read [references/rollout.md](./references/rollout.md).

## Deliverables

When using this skill, prefer producing:
- a decision-complete architecture plan
- a state model for workers, calls, contacts, and callbacks
- backend API and socket changes
- dashboard operator controls
- a migration path from Android workers to PBX or GSM gateway
