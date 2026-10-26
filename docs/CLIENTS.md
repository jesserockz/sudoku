# Clients (Kotlin Multiplatform)

The Android app, the web app and their shared logic live in one Gradle build at
the repository root. The Go server in `server/` is built separately.

| Module   | What it is                                                         |
| -------- | ------------------------------------------------------------------ |
| `shared` | Pure Kotlin: board model, validation, generator, game logic, API client. Targets JVM, Android and JS. |

## Requirements

- JDK 17 or newer.
- Android SDK (only for Android targets). Point Gradle at it with `ANDROID_HOME`
  or a `local.properties` file containing `sdk.dir=/path/to/android-sdk`.
- Nothing else: the Gradle wrapper downloads Gradle, and the Kotlin/JS plugin
  downloads Node.js for the JS tests.

## Tests

```sh
./gradlew :shared:jvmTest            # fastest; no Android SDK needed
./gradlew :shared:jsNodeTest         # same tests compiled to JS, run on Node.js
./gradlew :shared:testDebugUnitTest  # same tests on the Android target (needs the SDK)
```

CI (`.github/workflows/clients.yml`) runs all three on every change outside
`server/` and `deploy/`.

`kotlin-js-store/yarn.lock` pins the JS test dependencies. If a dependency
change makes the build complain that it is out of date, run
`./gradlew kotlinUpgradeYarnLock` and commit the result.
