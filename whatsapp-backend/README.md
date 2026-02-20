# WhatsApp Backend (Puerto 3010)

Servicio separado para vincular WhatsApp por QR y enviar mensajes/archivos.

## Arranque

```bash
cd whatsapp-backend
npm install
npm run start
```

Por defecto corre en `http://localhost:3010`.

## Endpoints

- `GET /health`
- `GET /status`
- `GET /qr`
- `POST /send`
- `POST /send-message`

Tambien expone alias:

- `GET /whatsapp/status`
- `GET /whatsapp/qr`
- `POST /whatsapp/send`
- `GET /api/whatsapp/status`
- `GET /api/whatsapp/qr`
- `POST /api/whatsapp/send`

## Envio de mensaje

`multipart/form-data` con:

- `to` (o `phone` / `number`) obligatorio
- `message` (o `text`) opcional
- `file` opcional

Ejemplo:

```bash
curl -X POST http://localhost:3010/send-message \
  -F "to=51999999999" \
  -F "message=Hola desde KENIA" \
  -F "file=@C:/ruta/archivo.pdf"
```

## Nota

- Si no esta vinculado, pide QR en `GET /qr`.
- La sesion de WhatsApp se guarda en `whatsapp-backend/session/`.
- Para cerrar sesion y regenerar QR: `POST /logout`.
