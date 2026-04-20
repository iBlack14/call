# State Model

## Worker state

Track per worker:
- `id`
- `name`
- `connected`
- `callState`
- `lastError`
- `lineLabel` if available
- `active`

## Contact state

Use explicit states:
- `pending`
- `dialing`
- `ringing`
- `in_call`
- `awaiting_callback`
- `completed`
- `failed`

Use explicit results:
- `agendado`
- `no_interesado`
- `requiere_asesor`
- `sin_respuesta`
- `reintentar`

## Campaign state

Track:
- `status`
- `activeContactId`
- `activeWorkerId`
- counters by contact status
- `lastError`

Recommended campaign statuses:
- `idle`
- `running`
- `paused`
- `completed`

## Callback state

Track:
- `contactId`
- `reason`
- `advisor`
- `status`
- `createdAt`

Recommended callback statuses:
- `pending`
- `completed`

