// P-EXT.3 (ADR-0038) — JetBrains plugin build. Uses the IntelliJ Platform Gradle Plugin (2.x).
// NOTE: built/tested in CI or on a machine with a JDK + Gradle — not compiled in the Bun harness env.
plugins {
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.lucidagentide"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.2")
        instrumentationTools()
    }
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "242"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
    // ParityTest walks up to the repo root to read harness/launcher/ext_parity.json (the shared spec).
    workingDir = rootDir
}
