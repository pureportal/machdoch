plugins {
    id("com.android.application")
}

val productVersion = providers.fileContents(rootProject.layout.projectDirectory.file("../../package.json")).asText.get()
    .let { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)!!.groupValues[1] }
val releaseVersion = productVersion.split(".").map(String::toInt)

android {
    namespace = "com.machdoch.fleet"
    compileSdk = 36
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "com.machdoch.fleet"
        minSdk = 33
        targetSdk = 36
        versionCode = releaseVersion[0] * 1000000 + releaseVersion[1] * 1000 + releaseVersion[2]
        versionName = productVersion
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.webkit:webkit:1.17.1")
    testImplementation("junit:junit:4.13.2")
}
