const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

const ANDROIDX_MARKER = 'LOOKMEFY_ANDROIDX_CORE_PIN';
const KOTLIN_MARKER = 'LOOKMEFY_KOTLIN_METADATA_COMPAT';

const androidXCorePin = `
// ${ANDROIDX_MARKER}: keep Expo SDK 53 compatible with newer OpenIAP transitive deps.
allprojects {
  configurations.configureEach {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == 'androidx.core' && ['core', 'core-ktx'].contains(details.requested.name)) {
        details.useVersion '1.16.0'
        details.because 'Expo SDK 53 builds with compileSdk 35 and Android Gradle Plugin 8.8.2.'
      }
    }
  }
}
`;

const kotlinMetadataCompatibility = `
// ${KOTLIN_MARKER}: OpenIAP Android artifacts can be published with newer Kotlin metadata.
kotlin {
    compilerOptions {
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
`;

function insertBeforeExpoRootPlugin(contents, snippet) {
  const marker = '\napply plugin: "expo-root-project"';
  if (!contents.includes(marker)) return `${contents.trimEnd()}\n${snippet}`;
  return contents.replace(marker, `${snippet}${marker}`);
}

module.exports = function withAndroidBuildCompatibility(config) {
  config = withProjectBuildGradle(config, (modConfig) => {
    const buildGradle = modConfig.modResults;
    if (
      buildGradle.language === 'groovy' &&
      !buildGradle.contents.includes(ANDROIDX_MARKER) &&
      !buildGradle.contents.includes("details.useVersion '1.16.0'")
    ) {
      buildGradle.contents = insertBeforeExpoRootPlugin(buildGradle.contents, androidXCorePin);
    }
    return modConfig;
  });

  config = withAppBuildGradle(config, (modConfig) => {
    const buildGradle = modConfig.modResults;
    if (
      buildGradle.language === 'groovy' &&
      !buildGradle.contents.includes(KOTLIN_MARKER) &&
      !buildGradle.contents.includes('-Xskip-metadata-version-check')
    ) {
      buildGradle.contents = `${buildGradle.contents.trimEnd()}\n${kotlinMetadataCompatibility}`;
    }
    return modConfig;
  });

  return config;
};
