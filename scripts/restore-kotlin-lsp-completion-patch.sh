#!/bin/zsh

set -eu

SCRIPT_DIRECTORY=${0:A:h}
ROOT_DIRECTORY=${SCRIPT_DIRECTORY:h}
PATCH_JAR=${KOTLIN_LSP_PATCH_JAR:-${ROOT_DIRECTORY}/server-patch/build/libs/language-server-completion-patch.jar}
EXPECTED_ORIGINAL_SHA256=9bf520789637525e7a302be6d0ba6fd6bd0663efbc550d992140cd39a43bad43

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
    print -u2 "Multiple Kotlin extension installations were found."
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

if [[ ! -f ${BACKUP_JAR} ]]; then
  print -u2 "Official backup was not found: ${BACKUP_JAR}"
  exit 1
fi

BACKUP_SHA256=$(shasum -a 256 "${BACKUP_JAR}" | awk '{print $1}')
if [[ ${BACKUP_SHA256} != ${EXPECTED_ORIGINAL_SHA256} ]]; then
  print -u2 "Backup SHA-256 does not match the supported official JAR."
  print -u2 "Current:  ${BACKUP_SHA256}"
  print -u2 "Expected: ${EXPECTED_ORIGINAL_SHA256}"
  exit 1
fi

TARGET_SHA256=$(shasum -a 256 "${TARGET_JAR}" | awk '{print $1}')
if [[ ${TARGET_SHA256} == ${EXPECTED_ORIGINAL_SHA256} ]]; then
  print "The official JAR is already installed: ${TARGET_JAR}"
  exit 0
fi

if [[ ! -f ${PATCH_JAR} ]]; then
  print -u2 "Patch payload is required to verify the installed target: ${PATCH_JAR}"
  exit 1
fi

PATCH_TEMP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/kotlin-lsp-completion-restore.XXXXXX")
trap 'rm -rf -- "${PATCH_TEMP_DIRECTORY}"' EXIT INT TERM
unzip -q "${PATCH_JAR}" -d "${PATCH_TEMP_DIRECTORY}"

entries=("${(@f)$(unzip -Z1 "${PATCH_JAR}" | sed -n '/\.class$/p')}")
for entry in "${entries[@]}"; do
  if ! cmp -s "${PATCH_TEMP_DIRECTORY}/${entry}" <(unzip -p "${TARGET_JAR}" "${entry}" 2>/dev/null); then
    print -u2 "The target does not contain this patch. Restore was stopped safely."
    print -u2 "Current SHA-256: ${TARGET_SHA256}"
    exit 1
  fi
done

cp -p "${BACKUP_JAR}" "${TARGET_JAR}"

RESTORED_SHA256=$(shasum -a 256 "${TARGET_JAR}" | awk '{print $1}')
if [[ ${RESTORED_SHA256} != ${EXPECTED_ORIGINAL_SHA256} ]]; then
  print -u2 "Restored JAR failed SHA-256 verification: ${RESTORED_SHA256}"
  exit 1
fi

print "Restored the official Kotlin language-server JAR."
print "Target:  ${TARGET_JAR}"
print "SHA-256: ${RESTORED_SHA256}"
print "Reload the editor or run 'Kotlin: Restart LSP server'."
