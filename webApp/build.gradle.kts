import org.jetbrains.kotlin.gradle.targets.js.webpack.KotlinWebpackConfig.DevServer

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.composeCompiler)
}

kotlin {
    js {
        browser {
            // `jsBrowserDevelopmentRun` serves on :8081 and forwards the API to a local
            // server: http://localhost:8080 unless overridden with -PapiUrl=...
            val apiUrl = providers.gradleProperty("apiUrl").getOrElse("http://localhost:8080")
            commonWebpackConfig {
                outputFileName = "sudoku.js"
                devServer = (devServer ?: DevServer()).copy(
                    port = 8081,
                    proxy = mutableListOf(DevServer.Proxy(context = mutableListOf("/api", "/healthz"), target = apiUrl)),
                )
            }
            // No browser-run tests here (the UI is exercised manually); the logic is tested in :shared.
            testTask { enabled = false }
        }
        binaries.executable()
    }

    sourceSets {
        jsMain.dependencies {
            implementation(project(":shared"))
            implementation(libs.compose.runtime)
            implementation(libs.compose.html.core)
        }
    }
}

// The production bundle the Go server serves as its static directory:
// `./gradlew :webApp:webDist` writes it to `build/web/` at the repository root.
tasks.register<Sync>("webDist") {
    group = "distribution"
    description = "Builds the production web client into build/web for the Go server."
    from(tasks.named("jsBrowserDistribution"))
    into(rootProject.layout.buildDirectory.dir("web"))
}
