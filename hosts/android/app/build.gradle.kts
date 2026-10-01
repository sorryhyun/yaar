plugins {
    id("com.android.application")
}

// The app carries YAAR's own version, read from the root package.json: the release APK is
// attached to that tag, and install.sh compares the installed versionCode against the one
// it computes from the tag. The formula, major * 1_000_000 + minor * 1_000 + patch, is
// install.sh's android_version_code(); change both or neither.
val yaarVersion: List<Int> = Regex("\"version\"\\s*:\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)")
    .find(rootDir.resolve("../../package.json").readText())
    ?.groupValues?.drop(1)?.map(String::toInt)
    ?: error("no x.y.z version in package.json")

android {
    namespace = "io.github.sorryhyun.yaar"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.sorryhyun.yaar"
        // MediaStore.Downloads (the host's `download`) needs no storage permission from 29 on.
        minSdk = 29
        targetSdk = 36
        versionCode = yaarVersion[0] * 1_000_000 + yaarVersion[1] * 1_000 + yaarVersion[2]
        versionName = yaarVersion.joinToString(".")
        manifestPlaceholders["appLabel"] = "YAAR"
    }

    // The release key, which release.yml decodes from its secrets. It is the app's identity
    // from the first public build on: Android refuses an update signed by any other key.
    // Without these variables a local assembleRelease comes out unsigned; build debug instead.
    signingConfigs {
        System.getenv("YAAR_ANDROID_KEYSTORE")?.let { keystore ->
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("YAAR_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("YAAR_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("YAAR_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        // -PsideBySide gives the debug build its own package, so it installs beside a release
        // app instead of needing that uninstalled (the two are signed by different keys).
        // termux-open-desktop.sh opens the release package only.
        debug {
            if (project.hasProperty("sideBySide")) {
                applicationIdSuffix = ".debug"
                manifestPlaceholders["appLabel"] = "YAAR debug"
            }
        }
        release {
            signingConfig = signingConfigs.findByName("release")
        }
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
