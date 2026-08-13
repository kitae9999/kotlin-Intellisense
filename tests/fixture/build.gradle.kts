plugins {
    kotlin("jvm") version "2.2.21"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":visible"))
    testImplementation(project(":unrelated"))
}

kotlin {
    jvmToolchain(21)
}
