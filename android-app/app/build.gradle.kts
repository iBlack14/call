plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseKeystorePath = providers.environmentVariable("VOIP_VC_KEYSTORE_PATH")
    .orElse("${rootProject.projectDir}/keystore/voip-vc-release.jks")
val releaseStorePassword = providers.environmentVariable("VOIP_VC_KEYSTORE_PASSWORD")
val releaseKeyAlias = providers.environmentVariable("VOIP_VC_KEY_ALIAS").orElse("voip-vc")
val releaseKeyPassword = providers.environmentVariable("VOIP_VC_KEY_PASSWORD")
val generatedVersionCode = providers.environmentVariable("ANDROID_VERSION_CODE")
    .orElse((System.currentTimeMillis() / 1000L).toString())
val generatedVersionName = providers.environmentVariable("ANDROID_VERSION_NAME")
    .orElse("1.1")

android {
    namespace = "com.voipvc.bridge"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.voipvc.bridge"
        minSdk = 24
        targetSdk = 35
        // Un valor creciente permite que Android instale cada APK como actualización.
        versionCode = generatedVersionCode.get().toInt()
        versionName = generatedVersionName.get()
        manifestPlaceholders["cleartextTraffic"] = "false"
        buildConfigField("String", "DEFAULT_BASE_URL", "\"https://llamada.viacomunicativa.com\"")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            storeFile = file(releaseKeystorePath.get())
            storePassword = releaseStorePassword.orNull
            keyAlias = releaseKeyAlias.get()
            keyPassword = releaseKeyPassword.orNull
        }
    }

    buildTypes {
        debug {
            manifestPlaceholders["cleartextTraffic"] = "true"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            manifestPlaceholders["cleartextTraffic"] = "false"
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    kotlinOptions { 
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")

    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json")
    }
}

base {
    archivesName.set("VOIP-VC")
}

tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
    doFirst {
        require(file(releaseKeystorePath.get()).isFile) {
            "Falta el keystore estable: ${releaseKeystorePath.get()}"
        }
        require(releaseStorePassword.orNull?.isNotBlank() == true) {
            "Falta VOIP_VC_KEYSTORE_PASSWORD"
        }
        require(releaseKeyPassword.orNull?.isNotBlank() == true) {
            "Falta VOIP_VC_KEY_PASSWORD"
        }
    }
}
