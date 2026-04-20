# Architecture Patterns

## 1. Android workers + backend orchestrator

Use when the system already has Android devices with physical SIMs and needs the cheapest path to real outbound calls.

```text
Dashboard -> Backend -> Android worker -> SIM -> customer
```

Characteristics:
- cheapest V1
- real outbound calling without trunk SIP
- callback derivation is preferred over live transfer
- scale by adding more Android workers

## 2. Backend + PBX

Use when live transfer, hold, conference, and advisor SIP extensions become primary requirements.

```text
Dashboard -> Backend -> PBX -> trunk/gateway -> customer
```

Characteristics:
- better transfer and hold support
- more telephony infrastructure
- cleaner advisor routing

## 3. Migration path

Prefer this progression:

1. Android workers + callback derivation
2. Android workers + advisor UI and callback queue
3. PBX or GSM gateway for live transfer

Keep backend orchestration interfaces stable so worker type can change later without rewriting dashboard and campaign logic.

