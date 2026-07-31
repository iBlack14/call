# VOIP VC - Skeleton de Vinculacion Celular <-> Web

Este proyecto conecta el dashboard web con la APK Android mediante tiempo real
(Socket.IO).

## Que incluye

- Dashboard web (`/`) para crear y unir sesion
- APK Android nativa como marcador vinculado
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

Variables opcionales en `.env`:

- `PUBLIC_BASE_URL`: URL publica del backend/API
- `PUBLIC_WEB_BASE_URL`: URL publica del frontend si lo separas del API
- `CORS_ORIGIN`: dominios permitidos, separados por coma
- `HOST`: por defecto `0.0.0.0` para VPS

## Flujo de prueba

1. En dashboard, click en **Crear Sesion**.
2. Click en **Vincular Dashboard**.
3. Abre la APK Android y toca **Escanear QR**.
4. Escanea uno de los QR personales del dashboard.
5. Desde dashboard, inicia la llamada general.

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

#### Varios celulares y reparto automatico

- Cada boton **Crear QR para otro celular** genera un token independiente.
- Un QR queda vinculado al primer `deviceId` Android que lo usa y no puede reutilizarse en otro equipo.
- Los celulares vinculados permanecen registrados aunque esten desconectados.
- Al llamar, el servidor reserva unicamente celulares conectados con estado `idle`.
- Cada celular recibe como maximo una llamada activa y un numero distinto.
- Cuando un celular termina, recibe el siguiente numero pendiente sin afectar las llamadas de los demas.

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

## Produccion en VPS

Este repo ya queda preparado para subir **solo el server** al VPS y que el APK se conecte por internet.

### Recomendado

- Ubuntu 22.04+
- Node.js 20 LTS
- Nginx como reverse proxy
- HTTPS con Let's Encrypt
- `systemd` o `pm2` para mantener el proceso vivo

### Variables de entorno base

Usa `.env.example` como plantilla:

```bash
cp .env.example .env
```

Configura al menos:

```env
PORT=3000
HOST=0.0.0.0
PUBLIC_BASE_URL=https://api.tudominio.com
PUBLIC_WEB_BASE_URL=https://api.tudominio.com
CORS_ORIGIN=https://api.tudominio.com
TRUST_PROXY=1
```

### Archivos listos para deploy

- `infrastructure/vps/voip-vc.service`: servicio `systemd`
- `infrastructure/vps/ecosystem.config.cjs`: opcion `pm2`
- `infrastructure/vps/nginx.voip-vc.conf`: reverse proxy base para Nginx

### Flujo sugerido en el VPS

```bash
sudo mkdir -p /opt/voip-vc
sudo chown -R $USER:$USER /opt/voip-vc
cd /opt/voip-vc
npm ci --omit=dev
cp .env.example .env
node server/server.js
```

Luego:

1. Ajusta `.env` con tu dominio real.
2. Instala el servicio `systemd` o usa `pm2`.
3. Configura Nginx apuntando a `127.0.0.1:3000`.
4. Activa HTTPS.
5. Verifica `https://api.tudominio.com/health`.

### Estabilidad que ya queda aplicada

- guardado atomico de sesiones
- cierre graceful con `SIGTERM` y `SIGINT`
- timeouts HTTP configurados
- limpieza automatica de sesiones viejas
- limites de payload JSON
- rate limiting basico para endpoints sensibles
- `Socket.IO` con `ping` y buffer definidos
- headers HTTP de endurecimiento basicos

### Sesiones persistentes en Supabase

Ejecuta `infrastructure/supabase/001_call_sessions.sql` en el SQL Editor de
Supabase. Después configura únicamente en el backend/Coolify:

```env
SUPABASE_URL=https://TU_PROYECTO.supabase.co
SUPABASE_SECRET_KEY=TU_CLAVE_SECRETA_DE_BACKEND
SUPABASE_SESSIONS_TABLE=call_sessions
SUPABASE_REQUIRED=1
```

La clave secreta nunca debe incluirse en `web/`, en la APK ni en Git. El
servidor migra automáticamente el JSON local cuando la tabla remota está
vacía. Comprueba la conexión en `/health`; debe indicar
`"driver":"supabase"` y `"connected":true`.

## APK para produccion

- La APK usa `BuildConfig.DEFAULT_BASE_URL` como base por defecto.
- `release` ahora queda con `cleartext` desactivado.
- Solo `debug` permite HTTP plano para `localhost`, `127.0.0.1` y `10.0.2.2`.

Para publicar con otro dominio por defecto, cambia este valor en:

- `android-app/app/build.gradle.kts`

## Despliegue rapido en la nube (Web + Server)

Para tener funcionando **dashboard + server** en una URL publica (por ahora):

1. Sube este repo a GitHub.
2. En Render, crea un **Web Service** desde ese repo.
3. Render detecta `render.yaml` automaticamente (Blueprint) o usa:
   - Build Command: `npm install`
   - Start Command: `npm run start`
4. Configura variables:
   - `PUBLIC_BASE_URL=https://TU-APP.onrender.com`
5. Espera deploy y prueba:
   - `https://TU-APP.onrender.com/` (dashboard)
   - `https://TU-APP.onrender.com/health`

Nota: en este repo, `web` se sirve desde el mismo `server`, asi que no necesitas desplegar frontend por separado para esta etapa.

## Web y Server en dominios distintos

Si separas frontend y backend (ejemplo: `https://app.tudominio.com` y `https://api.tudominio.com`):

1. En el backend configura:
   - `PUBLIC_BASE_URL=https://api.tudominio.com`
   - `PUBLIC_WEB_BASE_URL=https://app.tudominio.com`
   - `CORS_ORIGIN=https://app.tudominio.com,https://api.tudominio.com`
2. En el frontend agrega `apiBase` en la URL:
   - Dashboard: `https://app.tudominio.com/?apiBase=https://api.tudominio.com`

El frontend ya esta preparado para usar ese `apiBase` y conectarse por Socket.IO al dominio del backend.
