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
        commonMain.dependencies {
            api(libs.kotlinx.datetime)
        }
        jsMain.dependencies {
            // kotlinx-datetime needs the IANA database on JS for Pacific/Auckland.
            implementation(npm("@js-joda/timezone", libs.versions.js.joda.timezone.get()))
        }
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
