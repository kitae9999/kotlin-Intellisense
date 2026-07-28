#!/bin/zsh

set -eu

SCRIPT_DIRECTORY=${0:A:h}
ROOT_DIRECTORY=${SCRIPT_DIRECTORY:h}
PATCH_JAR=${KOTLIN_LSP_PATCH_JAR:-${ROOT_DIRECTORY}/server-patch/build/libs/language-server-completion-patch.jar}
EXPECTED_ORIGINAL_SHA256=9bf520789637525e7a302be6d0ba6fd6bd0663efbc550d992140cd39a43bad43
EXPECTED_PATCH_SHA256=93d644243d58f9fb85aa70857c4748ed616a351a2077e13d3e81e2bdcf0485dc

function resolve_target_jar() {
  if [[ -n ${KOTLIN_LSP_TARGET_JAR:-} ]]; then
    print -r -- "${KOTLIN_LSP_TARGET_JAR}"
    return
  fi

  local roots
  if [[ -n ${KOTLIN_LSP_EXTENSION_ROOT:-} ]]; then
    roots=("${KOTLIN_LSP_EXTENSION_ROOT}")
  else
    roots=(
      "${HOME}/.cursor/extensions"
      "${HOME}/.vscode/extensions"
    )
  fi

  local matches=()
  local root
  local candidate
  for root in "${roots[@]}"; do
    candidate="${root}/jetbrains.kotlin-server-0.0.6/server/lib/language-server.api.features.impl.common.jar"
    [[ -f ${candidate} ]] && matches+=("${candidate}")
  done

  if (( ${#matches[@]} == 0 )); then
    print -u2 "Kotlin by JetBrains 0.0.6 was not found."
    print -u2 "Set KOTLIN_LSP_TARGET_JAR or KOTLIN_LSP_EXTENSION_ROOT explicitly."
    return 1
  fi
  if (( ${#matches[@]} > 1 )); then
    print -u2 "Multiple Kotlin extension installations were found:"
    printf '  %s\n' "${matches[@]}" >&2
    print -u2 "Set KOTLIN_LSP_TARGET_JAR or KOTLIN_LSP_EXTENSION_ROOT explicitly."
    return 1
  fi

  print -r -- "${matches[1]}"
}

TARGET_JAR=$(resolve_target_jar)
BACKUP_JAR=${KOTLIN_LSP_BACKUP_JAR:-${TARGET_JAR}.continuous-completion-backup-LS-262.9593.0}

if [[ ! -f ${TARGET_JAR} ]]; then
  print -u2 "Target JAR was not found: ${TARGET_JAR}"
  exit 1
fi

if [[ ! -f ${PATCH_JAR} ]]; then
  print -u2 "Patch payload was not found: ${PATCH_JAR}"
  print -u2 "Build it first with ./server-patch/gradlew jar."
  exit 1
fi

PATCH_SHA256=$(shasum -a 256 "${PATCH_JAR}" | awk '{print $1}')
if [[ ${PATCH_SHA256} != ${EXPECTED_PATCH_SHA256} ]]; then
  print -u2 "Patch payload SHA-256 does not match the supported build."
  print -u2 "Current:  ${PATCH_SHA256}"
  print -u2 "Expected: ${EXPECTED_PATCH_SHA256}"
  exit 1
fi

PATCH_TEMP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/kotlin-lsp-completion-patch.XXXXXX")
trap 'rm -rf -- "${PATCH_TEMP_DIRECTORY}"' EXIT INT TERM
unzip -q "${PATCH_JAR}" -d "${PATCH_TEMP_DIRECTORY}"

function payload_matches_target() {
  local entry
  local entries
  entries=("${(@f)$(unzip -Z1 "${PATCH_JAR}" | sed -n '/\.class$/p')}")
  for entry in "${entries[@]}"; do
    if ! cmp -s "${PATCH_TEMP_DIRECTORY}/${entry}" <(unzip -p "${TARGET_JAR}" "${entry}" 2>/dev/null); then
      return 1
    fi
  done
  return 0
}

if payload_matches_target; then
  print "The completion patch is already installed: ${TARGET_JAR}"
  exit 0
fi

TARGET_SHA256=$(shasum -a 256 "${TARGET_JAR}" | awk '{print $1}')
if [[ ${TARGET_SHA256} != ${EXPECTED_ORIGINAL_SHA256} ]]; then
  print -u2 "Unsupported target JAR."
  print -u2 "Current:  ${TARGET_SHA256}"
  print -u2 "Expected: ${EXPECTED_ORIGINAL_SHA256}"
  exit 1
fi

if [[ -f ${BACKUP_JAR} ]]; then
  BACKUP_SHA256=$(shasum -a 256 "${BACKUP_JAR}" | awk '{print $1}')
  if [[ ${BACKUP_SHA256} != ${EXPECTED_ORIGINAL_SHA256} ]]; then
    print -u2 "Existing backup does not match the official JAR: ${BACKUP_JAR}"
    exit 1
  fi
else
  cp -p "${TARGET_JAR}" "${BACKUP_JAR}"
fi

JAR_COMMAND=$(command -v jar || true)
if [[ -z ${JAR_COMMAND} ]]; then
  print -u2 "The JDK 'jar' command is required."
  exit 1
fi

"${JAR_COMMAND}" uf "${TARGET_JAR}" \
  -C "${PATCH_TEMP_DIRECTORY}" \
  com/jetbrains/ls/api/features/impl/common/completion

if ! payload_matches_target; then
  print -u2 "Installed classes did not match the patch payload."
  print -u2 "The official backup is preserved at: ${BACKUP_JAR}"
  exit 1
fi

INSTALLED_SHA256=$(shasum -a 256 "${TARGET_JAR}" | awk '{print $1}')
print "Installed Kotlin LSP continuous-completion patch."
print "Target:  ${TARGET_JAR}"
print "Backup:  ${BACKUP_JAR}"
print "SHA-256: ${INSTALLED_SHA256}"
print "Reload the editor or run 'Kotlin: Restart LSP server'."
