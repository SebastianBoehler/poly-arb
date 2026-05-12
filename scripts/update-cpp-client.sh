#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${repo_root}/cpp/build"
git_ref="${POLYMARKET_CLIENT_GIT_TAG:-main}"

rm -rf \
  "${build_dir}/_deps/polymarket_client-src" \
  "${build_dir}/_deps/polymarket_client-build" \
  "${build_dir}/_deps/polymarket_client-subbuild"

cmake -S "${repo_root}/cpp" -B "${build_dir}" \
  -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}" \
  -DPOLYMARKET_CLIENT_GIT_TAG="${git_ref}" \
  -DFETCHCONTENT_UPDATES_DISCONNECTED=OFF \
  '-UOPENSSL_*'

cmake --build "${build_dir}" --target discovery_mode polymarket_arb -j "${JOBS:-4}"
