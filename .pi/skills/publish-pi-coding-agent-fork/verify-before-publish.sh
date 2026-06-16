#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root regardless of the caller's current directory.
cd "$(dirname "$0")/../../.."

model_catalog_snapshot_dir=$(mktemp -d)
trap 'rm -rf "$model_catalog_snapshot_dir"' EXIT

ai_package_name=$(node -p "require('./packages/ai/package.json').name")
ai_package_version=$(node -p "require('./packages/ai/package.json').version")
ai_package_tarball=$(npm pack "$ai_package_name@$ai_package_version" --pack-destination "$model_catalog_snapshot_dir" --silent)
tar -xzf "$model_catalog_snapshot_dir/$ai_package_tarball" -C "$model_catalog_snapshot_dir"

if [[ ! -f "$model_catalog_snapshot_dir/package/dist/providers/data/.manifest.json" ]]; then
	echo "Published $ai_package_name@$ai_package_version is missing its model catalog snapshot" >&2
	exit 1
fi

# Online model generation writes two kinds of files that require different restoration sources:
# tracked generated TypeScript is restored from git (without overwriting pre-existing edits),
# while gitignored provider JSON is restored from the published package snapshot because git cannot restore it.
mapfile -t generated_model_catalog_files < <(git ls-files ':(glob)**/*.generated.ts' 'packages/ai/src/providers/*.models.ts')
declare -A generated_model_catalog_dirty_at_start=()
if (( ${#generated_model_catalog_files[@]} > 0 )); then
	while IFS= read -r path; do
		generated_model_catalog_dirty_at_start["$path"]=1
	done < <(git status --porcelain -- "${generated_model_catalog_files[@]}" | sed 's/^...//')
fi

restore_generated_model_catalogs() {
	local files_to_restore=()
	for path in "${generated_model_catalog_files[@]}"; do
		if [[ -z "${generated_model_catalog_dirty_at_start[$path]+x}" ]]; then
			files_to_restore+=("$path")
		fi
	done
	if (( ${#files_to_restore[@]} > 0 )); then
		git restore -- "${files_to_restore[@]}"
	fi
}

restore_published_model_catalog_data() {
	rm -rf packages/ai/src/providers/data
	mkdir -p packages/ai/src/providers/data
	cp -a "$model_catalog_snapshot_dir/package/dist/providers/data/." packages/ai/src/providers/data/
}

cleanup() {
	local exit_code=$?
	set +e
	restore_generated_model_catalogs
	restore_published_model_catalog_data
	rm -rf "$model_catalog_snapshot_dir"
	exit "$exit_code"
}

trap cleanup EXIT

# Hydrate dependencies without running package lifecycle scripts. This also catches
# stale node_modules after a rebase, while avoiding unreviewed install scripts.
npm install --ignore-scripts

# Regenerate the coding-agent shrinkwrap from the current package metadata.
npm run shrinkwrap:coding-agent

# Build the full workspace so internal package outputs and generated types are fresh.
npm run build

# Run the coding-agent publish preparation step: clean, build, and regenerate shrinkwrap.
npm --prefix packages/coding-agent run prepublishOnly

# Build steps refresh tracked generated source files and gitignored AI model
# data from mutable remote APIs. Keep the fork publish on the released sources:
# restore clean tracked files from git and model data from the published
# upstream package before checking and packing.
restore_generated_model_catalogs
restore_published_model_catalog_data

# Run the repository checks before packaging.
npm run check

# Build a fork-named tarball from the upstream-shaped workspace package. The
# helper prints inspected tarball metadata to stderr and emits machine-readable
# publish metadata on stdout.
pack_metadata=$(node --import tsx .pi/skills/publish-pi-coding-agent-fork/pack-forked-coding-agent.ts)
fork_tarball=$(jq -r '.tarball' <<<"$pack_metadata")
fork_version=$(jq -r '.forkVersion' <<<"$pack_metadata")
fork_tag=$(jq -r '.forkTag' <<<"$pack_metadata")

npm publish "$fork_tarball" --access public --tag latest --dry-run

cat <<MSG

If the dry-run file list looks correct, publish with:

  git tag -a "$fork_tag" -m "Release @geraschenko/pi-coding-agent@$fork_version"
  git push origin "refs/tags/$fork_tag"
  npm publish "$fork_tarball" --access public --tag latest
MSG
