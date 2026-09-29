plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.sorryhyun.yaar"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.sorryhyun.yaar"
        // MediaStore.Downloads (the host's `download`) needs no storage permission from 29 on.
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// The proposal's dependency budget: androidx.webkit + androidx.core, no Play services.
dependencies {
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.core:core:1.19.1")
}
