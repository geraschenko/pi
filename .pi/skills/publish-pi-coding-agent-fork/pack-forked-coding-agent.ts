import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackResult {
	filename: string;
}

interface PackageJson {
	name?: string;
	version?: string;
	publishConfig?: Record<string, unknown>;
}

interface ShrinkwrapJson {
	name?: string;
	version?: string;
	packages?: {
		""?: {
			name?: string;
			version?: string;
		};
	};
}

interface ForkPackMetadata {
	tarball: string;
	packageName: string;
	forkVersion: string;
	forkBranch: string;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const workspace = "packages/coding-agent";
const forkName = "@geraschenko/pi-coding-agent";
const upstreamVersion = readPackageJson(join(repoRoot, workspace, "package.json")).version;
if (!upstreamVersion) {
	throw new Error(`${workspace}/package.json is missing version`);
}
const forkVersion = resolveForkVersion(upstreamVersion);
const outDir = resolve(repoRoot, ".tmp/fork-pack");

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readPackageJson(path: string): PackageJson {
	return readJson<PackageJson>(path);
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: string[]): string {
	return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function resolveForkVersion(baseVersion: string): string {
	const revision = process.env.FORK_VERSION ?? "0";
	if (!/^\d+$/.test(revision)) {
		throw new Error(`FORK_VERSION must be a numeric fork revision; got ${revision}`);
	}
	return `${baseVersion}-fork.${revision}`;
}

function rewritePackageJson(stagePackageDir: string): void {
	const packageJsonPath = join(stagePackageDir, "package.json");
	const packageJson = readJson<PackageJson>(packageJsonPath);
	packageJson.name = forkName;
	packageJson.version = forkVersion;
	packageJson.publishConfig = { ...(packageJson.publishConfig ?? {}), access: "public" };
	writeJson(packageJsonPath, packageJson);
}

function rewriteShrinkwrap(stagePackageDir: string): void {
	const shrinkwrapPath = join(stagePackageDir, "npm-shrinkwrap.json");
	const shrinkwrap = readJson<ShrinkwrapJson>(shrinkwrapPath);
	shrinkwrap.name = forkName;
	shrinkwrap.version = forkVersion;
	if (shrinkwrap.packages?.[""]) {
		shrinkwrap.packages[""].name = forkName;
		shrinkwrap.packages[""].version = forkVersion;
	}
	writeJson(shrinkwrapPath, shrinkwrap);
}

function tarballName(): string {
	return `geraschenko-pi-coding-agent-${forkVersion}.tgz`;
}

function readTarballJson<T>(tarball: string, path: string): T {
	const output = execFileSync("tar", ["-xOf", tarball, path], { encoding: "utf8" });
	return JSON.parse(output) as T;
}

function inspectTarball(tarball: string): void {
	const packageJson = readTarballJson<PackageJson>(tarball, "package/package.json");
	const shrinkwrap = readTarballJson<ShrinkwrapJson>(tarball, "package/npm-shrinkwrap.json");

	console.error("Packed package.json:");
	console.error(JSON.stringify(packageJson, null, 2));
	console.error("\nPacked npm-shrinkwrap root metadata:");
	console.error(
		JSON.stringify(
			{
				name: shrinkwrap.name,
				version: shrinkwrap.version,
				root: shrinkwrap.packages?.[""] && {
					name: shrinkwrap.packages[""].name,
					version: shrinkwrap.packages[""].version,
				},
			},
			null,
			2,
		),
	);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const packOutput = run("npm", ["pack", "--workspace", workspace, "--pack-destination", outDir, "--json"]);
const packResults = JSON.parse(packOutput) as PackResult[];
const sourceTarball = resolve(outDir, basename(packResults[0]?.filename ?? ""));
if (!packResults[0]?.filename) {
	throw new Error(`npm pack did not return a tarball filename: ${packOutput}`);
}

const stageDir = mkdtempSync(join(tmpdir(), "pi-coding-agent-fork-pack-"));
try {
	execFileSync("tar", ["-xzf", sourceTarball, "-C", stageDir], { stdio: "inherit" });
	const stagePackageDir = join(stageDir, "package");
	rewritePackageJson(stagePackageDir);
	rewriteShrinkwrap(stagePackageDir);

	const finalTarball = resolve(outDir, tarballName());
	rmSync(finalTarball, { force: true });
	execFileSync("tar", ["-czf", finalTarball, "-C", stageDir, "package"], { stdio: "inherit" });
	inspectTarball(finalTarball);

	const metadata: ForkPackMetadata = {
		tarball: finalTarball,
		packageName: forkName,
		forkVersion,
		forkBranch: `br-${forkVersion}`,
	};
	console.log(JSON.stringify(metadata));
} finally {
	rmSync(stageDir, { recursive: true, force: true });
}
