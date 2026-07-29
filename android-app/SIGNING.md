# Firma estable de la APK

Android solamente instala una APK como actualización cuando conserva:

- el mismo `applicationId` (`com.voipvc.bridge`);
- el mismo certificado de firma;
- un `versionCode` superior.

## Crear la clave una sola vez

Desde `android-app`:

```bash
mkdir -p keystore
keytool -genkeypair -v \
  -keystore keystore/voip-vc-release.jks \
  -alias voip-vc \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Guarda una copia segura del archivo y sus contraseñas. No generes otra clave
para versiones futuras y no la subas al repositorio.

Para compilaciones locales también puedes guardar las credenciales en
`keystore/signing.properties`:

```properties
storeFile=/ruta/absoluta/voip-vc-release.jks
storePassword=CONTRASENA_DEL_ALMACEN
keyAlias=voip-vc
keyPassword=CONTRASENA_DE_LA_CLAVE
```

La carpeta `keystore` está excluida de Git. Debes respaldarla de forma segura.

## Compilar una actualización

```bash
export VOIP_VC_KEYSTORE_PATH="$PWD/keystore/voip-vc-release.jks"
export VOIP_VC_KEYSTORE_PASSWORD="CONTRASENA_DEL_ALMACEN"
export VOIP_VC_KEY_ALIAS="voip-vc"
export VOIP_VC_KEY_PASSWORD="CONTRASENA_DE_LA_CLAVE"
export ANDROID_VERSION_NAME="1.1"
./gradlew clean assembleRelease
```

Si no se define `ANDROID_VERSION_CODE`, la compilación usa la fecha actual en
segundos como código creciente. Las siguientes compilaciones realizadas con
esta misma clave podrán instalarse directamente encima de la aplicación.

La primera APK firmada con esta nueva clave requerirá desinstalar cualquier
APK anterior firmada con un certificado diferente.
