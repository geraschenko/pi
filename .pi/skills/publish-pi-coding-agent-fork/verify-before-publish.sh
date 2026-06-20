#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root regardless of the caller's current directory.
cd "$(dirname "$0")/../../.."

# Hydrate dependencies without running package lifecycle scripts. This also catches
# stale node_modules after a rebase, while avoiding unreviewed install scripts.
npm install --ignore-scripts

# Regenerate the coding-agent shrinkwrap from the current package metadata.
npm run shrinkwrap:coding-agent

# Build the full workspace so internal package outputs and generated types are fresh.
npm run build

# Run the coding-agent publish preparation step: clean, build, and regenerate shrinkwrap.
npm --prefix packages/coding-agent run prepublishOnly

# The build can refresh tracked generated source files such as
# packages/ai/src/models.generated.ts. The coding-agent fork publish should stay
# minimal, so restore tracked *.generated.ts files before checking and packing.
mapfile -t generated_files < <(git ls-files ':(glob)**/*.generated.ts')
if (( ${#generated_files[@]} > 0 )); then
	git restore -- "${generated_files[@]}"
fi

# Run the repository checks before packaging.
npm run check

# Show the package contents without publishing, so the file list can be inspected.
npm pack --workspace packages/coding-agent --dry-run

cat <<'MSG'

If the dry-run file list looks correct, publish with:

  npm publish --workspace packages/coding-agent --access public --tag latest
MSG
