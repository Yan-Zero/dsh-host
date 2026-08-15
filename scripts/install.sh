#!/bin/sh
# Private, repeatable dsh-host installation for POSIX SSH hosts.
set -eu

NODE_VERSION="${DSH_HOST_NODE_VERSION:-24.19.0}"
DSH_VERSION="${DSH_VERSION:-0.1.0-rc.6}"
DSH_HOST_VERSION="${DSH_HOST_VERSION:-0.1.0}"
DSH_HOST_PACKAGE="${DSH_HOST_PACKAGE:-dsh-host@${DSH_HOST_VERSION}}"
INSTALL_ROOT="${DSH_HOST_INSTALL_ROOT:-${HOME}/.dsh-host}"
HARNESS_HOME="${DSH_HOME:-${HOME}/.dsh}"
PNPM_VERSION="${DSH_HOST_PNPM_VERSION:-11.21.0}"

case "$INSTALL_ROOT" in
  ''|/|.) echo "dsh-host: unsafe install root: $INSTALL_ROOT" >&2; exit 2 ;;
esac

case "$(uname -s)" in
  Linux) node_os=linux ;;
  Darwin) node_os=darwin ;;
  *) echo "dsh-host: unsupported operating system: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) node_arch=x64 ;;
  arm64|aarch64) node_arch=arm64 ;;
  *) echo "dsh-host: unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

runtime_name="node-v${NODE_VERSION}-${node_os}-${node_arch}"
runtime_dir="${INSTALL_ROOT}/runtime/${runtime_name}"
release_dir="${INSTALL_ROOT}/releases/dsh-${DSH_VERSION}"
tools_dir="${INSTALL_ROOT}/tools"
work_dir="${INSTALL_ROOT}/.install-$$"

mkdir -p "$INSTALL_ROOT/runtime" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/bin" "$HARNESS_HOME"
chmod 700 "$INSTALL_ROOT" "$HARNESS_HOME" 2>/dev/null || true
rm -rf "$work_dir"
mkdir -m 700 "$work_dir"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT HUP INT TERM

if [ ! -x "$runtime_dir/bin/node" ]; then
  archive="${runtime_name}.tar.xz"
  dist="https://nodejs.org/dist/v${NODE_VERSION}"
  echo "dsh-host: downloading Node.js v${NODE_VERSION}"
  curl --fail --location --silent --show-error "$dist/$archive" --output "$work_dir/$archive"
  curl --fail --location --silent --show-error "$dist/SHASUMS256.txt" --output "$work_dir/SHASUMS256.txt"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$work_dir/SHASUMS256.txt")"
  [ -n "$expected" ] || { echo "dsh-host: checksum for $archive is missing" >&2; exit 1; }
  actual="$(sha256sum "$work_dir/$archive" | awk '{ print $1 }')"
  [ "$actual" = "$expected" ] || { echo "dsh-host: Node.js checksum mismatch" >&2; exit 1; }
  tar -xJf "$work_dir/$archive" -C "$work_dir"
  mv "$work_dir/$runtime_name" "$runtime_dir"
fi

node_bin="$runtime_dir/bin/node"
npm_bin="$runtime_dir/bin/npm"
export PATH="$runtime_dir/bin:$PATH"
if [ ! -x "$tools_dir/node_modules/.bin/pnpm" ]; then
  echo "dsh-host: installing pnpm ${PNPM_VERSION}"
  "$npm_bin" install --no-audit --no-fund --prefix "$tools_dir" "pnpm@${PNPM_VERSION}"
fi

if [ ! -f "$release_dir/node_modules/@deepseek-ai/dsh/package.json" ]; then
  staged_release="$work_dir/release"
  mkdir -p "$staged_release"
  echo "dsh-host: installing DeepSeek Harness ${DSH_VERSION}"
  "$npm_bin" install --no-audit --no-fund --prefix "$staged_release" "@deepseek-ai/dsh@${DSH_VERSION}"
  mv "$staged_release" "$release_dir"
fi

# npm currently treats unreviewed install scripts as advisory, but the PTY
# helper's executable bit is important enough to repair and validate directly.
subprocess_dir="$release_dir/node_modules/@deepseek-ai/dsh-subprocess-local"
if [ -f "$subprocess_dir/scripts/ensure-spawn-helper.mjs" ]; then
  "$node_bin" "$subprocess_dir/scripts/ensure-spawn-helper.mjs"
fi
"$node_bin" --input-type=module - "$release_dir" <<'NODE'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const release = process.argv[2]
const fromSubprocess = createRequire(join(release, 'node_modules/@deepseek-ai/dsh-subprocess-local/package.json'))
const pty = fromSubprocess('node-pty')
const output = await new Promise((resolve, reject) => {
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf dsh-host-runtime-ok'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  })
  let text = ''
  const timeout = setTimeout(() => {
    try { terminal.kill() } catch {}
    reject(new Error('PTY runtime verification timed out'))
  }, 10_000)
  terminal.onData((chunk) => { text += chunk })
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout)
    if (exitCode !== 0) reject(new Error(`PTY runtime verification exited ${exitCode}`))
    else resolve(text)
  })
})
if (output !== 'dsh-host-runtime-ok') throw new Error(`unexpected PTY output: ${JSON.stringify(output)}`)
NODE

export PATH="$tools_dir/node_modules/.bin:$PATH"
export DSH_HOME="$HARNESS_HOME"
dsh_entry="$release_dir/node_modules/@deepseek-ai/dsh/lib/bin.js"

# A copied source tarball must outlive the temporary SSH upload directory,
# because the profile lockfile records its package spec for later upgrades.
if [ -f "$DSH_HOST_PACKAGE" ]; then
  mkdir -p "$INSTALL_ROOT/packages"
  package_name="$(basename "$DSH_HOST_PACKAGE")"
  package_hash="$(sha256sum "$DSH_HOST_PACKAGE" | awk '{ print substr($1, 1, 16) }')"
  durable_package="$INSTALL_ROOT/packages/${package_name%.tgz}-${package_hash}.tgz"
  if [ "$DSH_HOST_PACKAGE" != "$durable_package" ]; then
    cp "$DSH_HOST_PACKAGE" "$durable_package"
  fi
  DSH_HOST_PACKAGE="$durable_package"
fi

echo "dsh-host: installing Backend bundle ${DSH_HOST_PACKAGE}"
"$node_bin" "$dsh_entry" plugin --profile dsh-host add "$DSH_HOST_PACKAGE"

ln -sfn "$runtime_dir" "$INSTALL_ROOT/runtime/current"
ln -sfn "$release_dir" "$INSTALL_ROOT/current"

wrapper_tmp="$work_dir/dsh"
printf '%s\n' \
  '#!/bin/sh' \
  'set -eu' \
  "DSH_HOST_INSTALL_ROOT=\"\${DSH_HOST_INSTALL_ROOT:-$INSTALL_ROOT}\"" \
  "DSH_HOME=\"\${DSH_HOME:-$HARNESS_HOME}\"" \
  'export DSH_HOME' \
  'PATH="$DSH_HOST_INSTALL_ROOT/runtime/current/bin:$DSH_HOST_INSTALL_ROOT/tools/node_modules/.bin:$PATH"' \
  'export PATH' \
  'exec "$DSH_HOST_INSTALL_ROOT/runtime/current/bin/node" "$DSH_HOST_INSTALL_ROOT/current/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"' \
  > "$wrapper_tmp"
chmod 755 "$wrapper_tmp"
mv "$wrapper_tmp" "$INSTALL_ROOT/bin/dsh"

host_wrapper_tmp="$work_dir/dsh-host"
printf '%s\n' \
  '#!/bin/sh' \
  'set -eu' \
  "DSH_HOST_INSTALL_ROOT=\"\${DSH_HOST_INSTALL_ROOT:-$INSTALL_ROOT}\"" \
  'exec "$DSH_HOST_INSTALL_ROOT/bin/dsh" --profile dsh-host "$@"' \
  > "$host_wrapper_tmp"
chmod 755 "$host_wrapper_tmp"
mv "$host_wrapper_tmp" "$INSTALL_ROOT/bin/dsh-host"

echo "dsh-host: starting or reusing the Backend"
"$INSTALL_ROOT/bin/dsh-host" --replace
"$INSTALL_ROOT/bin/dsh-host" --status
echo "dsh-host: installed at $INSTALL_ROOT"
echo "dsh-host: add $INSTALL_ROOT/bin to PATH"
