plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.swingclips.capture"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.swingclips.capture"
        minSdk = 28 // Android 9: the Galaxy S8's last update
        targetSdk = 35
        versionCode = 5
        versionName = "0.5"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // JVM unit tests (app/src/test): the practice feed's logic, no phone needed.
    testImplementation("junit:junit:4.13.2")
}
