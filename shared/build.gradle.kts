import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidKmpLibrary)
}

kotlin {
    // Plain JVM target: fast, SDK-free tests of the common code.
    jvm {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
    }

    android {
        namespace = "sudoku.shared"
        compileSdk = libs.versions.android.compileSdk.get().toInt()
        minSdk = libs.versions.android.minSdk.get().toInt()
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
        // Runs the common tests on the JVM against the Android target.
        withHostTest {}
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
