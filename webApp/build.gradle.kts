import java.security.MessageDigest
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
    // Stamp the service worker with this build's app shell: every file it serves
    // (not source maps) and a hash of their contents, which names the cache.
    doLast {
        val dir = destinationDir
        val shell = dir.walkTopDown()
            .filter { it.isFile && it.name != "sw.js" && !it.name.endsWith(".map") && !it.name.endsWith(".LICENSE.txt") }
            .map { it.relativeTo(dir).invariantSeparatorsPath }
            .sorted()
            .toList()
        val digest = MessageDigest.getInstance("SHA-256")
        shell.forEach { digest.update(it.toByteArray()); digest.update(dir.resolve(it).readBytes()) }
        val version = digest.digest().joinToString("") { "%02x".format(it) }.take(16)
        // Relative to the worker's scope, so the bundle can live under any path.
        val paths = (listOf("./") + shell).joinToString(", ") { "\"$it\"" }
        val sw = dir.resolve("sw.js")
        val stamped = sw.readText()
            .replace(Regex("""const BUILD_VERSION = .*;"""), "const BUILD_VERSION = \"$version\";")
            .replace(Regex("""const SHELL = \[.*];"""), "const SHELL = [$paths];")
        check("\"$version\"" in stamped && "\"index.html\"" in stamped) { "couldn't stamp $sw" }
        sw.writeText(stamped)
    }
}
