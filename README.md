# Kenia - Skeleton de Vinculacion Celular <-> Web

Este proyecto crea un **esqueleto funcional** para conectar un dashboard web con un cliente movil usando tiempo real (Socket.IO).

## Que incluye

- Dashboard web (`/`) para crear y unir sesion
- Cliente movil web (`/phone`) para simular el telefono
- Vinculacion por QR con token de sesion
- Backend Node.js + Express + Socket.IO
- Endpoint de pairing para Android (`POST /api/android/pair`)
- Eventos base: crear sesion, vincular, marcar, colgar, actualizar estado

## Arranque

```bash
npm install
npm run start
```

Abrir:

- Dashboard: `http://localhost:3000/`
- Cliente movil: `http://localhost:3000/phone`

## Flujo de prueba

1. En dashboard, click en **Crear Sesion**.
2. Click en **Vincular Dashboard**.
3. Escanea el QR con tu celular o abre el link de vinculacion.
4. En `/phone` se autocompleta `code + token` y se vincula.
5. Desde dashboard, usa **Llamar** o **Colgar**.

## Endpoint para APK Android

Request:

```http
POST /api/android/pair
Content-Type: application/json

{
  "code": "ABC123",
  "token": "TOKEN_DEL_QR",
  "deviceId": "android-device-id",
  "deviceName": "Samsung A54"
}
```

## APK Android (bridge real)

Se agrego proyecto Android en `android-app/` con:

- Escaneo QR (lee `code` + `token`)
- Pairing a `POST /api/android/pair`
- Socket.IO como `role=phone`
- Ejecucion de llamada con `CALL_PHONE`

### Build rapido

1. Abre `android-app/` en Android Studio.
2. Espera sync de Gradle.
3. Ejecuta `Build > Build APK(s)`.
4. APK debug en:
   `android-app/app/build/outputs/apk/debug/app-debug.apk`

### Flujo real

1. Levanta backend (`PORT=3100` o libre).
2. En dashboard crea sesion y genera QR.
3. En la APK toca **Escanear QR**.
4. Toca **Vincular Celular**.
5. Desde dashboard usa **Llamar**.

Nota: colgar llamada remotamente en Android requiere privilegios de dialer por defecto/sistema.

Respuesta:

```json
{
  "ok": true,
  "code": "ABC123",
  "socket": {
    "url": "http://localhost:3000",
    "role": "phone",
    "token": "TOKEN_DEL_QR"
  }
}
```

## Siguiente integracion real

Para llamadas reales desde Android/iOS, reemplaza la simulacion de `web/phone.js` por:

- app movil nativa con permisos de llamada
- puente hacia este backend (WebSocket/HTTP)
- proveedor de telefonia (SIP/Twilio/operador)

Este skeleton esta listo para evolucionar hacia ese bridge real.
