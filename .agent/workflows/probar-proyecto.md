---
description: Cómo levantar y probar el proyecto VOIP VC
---

Sigue estos pasos para iniciar todos los componentes del sistema:

### 1. Servidor Principal (Main Server)
Este servidor gestiona las sesiones, el socket y sirve el dashboard web.
```bash
cd server
npm start
```
*Acceso:* [http://localhost:3000](http://localhost:3000)

### 2. Backend de WhatsApp
Necesario para usar las funciones de envío de mensajes y cotizaciones por WA.
```bash
cd whatsapp-backend
npm start
```
*Nota:* Escanea el QR desde el dashboard una vez que este servidor esté corriendo.

### 3. Aplicación Android (Compilación)
Para probar la función de llamadas, debes compilar el APK.
```bash
cd android-app
# En Windows (PowerShell)
.\gradlew assembleDebug
```
*Ubicación del APK:* `android-app\app\build\outputs\apk\debug\Phone-VC-debug.apk`

### 4. Flujo de Prueba
1. Abre el **Dashboard** en tu navegador.
2. Haz clic en **"Crear Sesión"**.
3. Abre la **App Android**, escanea el QR del Dashboard para vincular.
4. En el Dashboard, agrega un contacto y haz clic en **"Llamar"**.
5. Verifica que la App Android inicie la llamada y el audio se escuche en el navegador.
