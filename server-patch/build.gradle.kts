import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.3.21"
}

repositories {
    mavenCentral()
}

val serverHome = providers.gradleProperty("kotlinLspServerHome")
    .orElse(providers.environmentVariable("KOTLIN_LSP_SERVER_HOME"))
    .orNull
    ?: error(
        "Set -PkotlinLspServerHome=/path/to/jetbrains.kotlin-server/server " +
            "or KOTLIN_LSP_SERVER_HOME."
    )

dependencies {
    compileOnly(fileTree("$serverHome/lib") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/kotlin/lib") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/kotlin.lsp/lib") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/kotlin.lsp/lib/modules") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/java/lib") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/java/lib/modules") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/java-base.lsp/lib") { include("*.jar") })
    compileOnly(fileTree("$serverHome/plugins/java-base.lsp/lib/modules") { include("*.jar") })
}

kotlin {
    jvmToolchain(24)
    compilerOptions {
        jvmTarget = JvmTarget.JVM_24
        freeCompilerArgs.add("-Xcontext-parameters")
        freeCompilerArgs.add(
            "-Xfriend-paths=$serverHome/lib/product.jar," +
                "$serverHome/lib/language-server.api.features.impl.common.jar"
        )
    }
}

tasks.jar {
    archiveFileName = "language-server-completion-patch.jar"
}
