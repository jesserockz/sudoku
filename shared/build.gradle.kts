import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidLibrary)
}

kotlin {
    // Plain JVM target: fast, SDK-free tests of the common code.
    jvm {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
    }

    androidTarget {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
    }

    js {
        browser {
            testTask {
                // Headless browsers aren't guaranteed in CI or dev containers; the
                // Node.js test run exercises the same JS output.
                enabled = false
            }
        }
        nodejs {
            testTask {
                useMocha {
                    timeout = "60s"
                }
            }
        }
    }

    sourceSets {
        commonTest.dependencies {
            implementation(libs.kotlin.test)
        }
    }
}

android {
    namespace = "sudoku.shared"
    compileSdk = libs.versions.android.compileSdk.get().toInt()
    defaultConfig {
        minSdk = libs.versions.android.minSdk.get().toInt()
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
