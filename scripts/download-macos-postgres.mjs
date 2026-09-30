#!/usr/bin/env node
// Build-time only: the installed app never fetches PostgreSQL or runs npm hooks.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const postgresSource = {
  version: "17.10",
  url: "https://get.enterprisedb.com/postgresql/postgresql-17.10-1-osx-binaries.zip",
  sha256: "67b32bd5ab4e41dc7d8233c5077001b4b2f3f3c92635e214807c86a22968fe03",
};
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
}
export function machoFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return machoFiles(file);
    if (!entry.isFile()) return [];
    return run("file", ["-b", file]).includes("Mach-O") ? [file] : [];
  });
}
function dependencies(file) {
  // Inspect every architecture in universal binaries. LC_ID_DYLIB
  // is an identity, not a dependency, and must not be interpreted as one.
  const output = run("otool", ["-l", file]);
  return [
    ...output.matchAll(
      /cmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB)\n[\s\S]*?\n\s*name (.*?) \(offset/g
    ),
  ].map((match) => match[1]);
}
export function verifyPostgres(directory, arch) {
  directory = path.resolve(directory);
  const files = machoFiles(directory);
  for (const file of files) {
    run("lipo", [file, "-verify_arch", arch === "x64" ? "x86_64" : "arm64"]);
    for (const dependency of dependencies(file)) {
      if (
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/")
      )
        continue;
      if (!dependency.startsWith("@loader_path/"))
        throw new Error(`Non-relocatable dependency in ${file}: ${dependency}`);
      const resolved = path.resolve(
        path.dirname(file),
        dependency.slice("@loader_path/".length)
      );
      if (
        !resolved.startsWith(`${directory}${path.sep}`) ||
        !existsSync(resolved)
      )
        throw new Error(`Missing bundled dependency: ${dependency} in ${file}`);
    }
  }
  return files;
}
function fetchArchive(source) {
  const cache = path.resolve(
    process.env.DISPATCH_POSTGRES_CACHE ??
      path.join(here, "../dist/cache/postgres")
  );
  mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, path.basename(source.url));
  if (!existsSync(archive)) {
    const partial = `${archive}.${process.pid}.partial`;
    try {
      run("curl", [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--output",
        partial,
        source.url,
      ]);
      if (
        createHash("sha256").update(readFileSync(partial)).digest("hex") !==
        source.sha256
      )
        throw new Error("PostgreSQL archive checksum mismatch");
      renameSync(partial, archive);
    } finally {
      rmSync(partial, { force: true });
    }
  }
  if (
    createHash("sha256").update(readFileSync(archive)).digest("hex") !==
    source.sha256
  )
    throw new Error(`PostgreSQL archive checksum mismatch: ${archive}`);
  return archive;
}
export async function downloadPostgres(arch, destination) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch))
    throw new Error("Requires macOS and arm64 or x64 architecture");
  destination = path.resolve(destination);
  if (existsSync(destination))
    throw new Error(`Refusing to overwrite ${destination}`);
  const archive = fetchArchive(postgresSource);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "dispatch-postgres-"));
  try {
    run("unzip", [
      "-q",
      archive,
      "pgsql/bin/*",
      "pgsql/lib/*",
      "pgsql/share/postgresql/*",
      "pgsql/doc/postgresql/html/legalnotice.html",
      "-d",
      temporary,
    ]);
    const source = path.join(temporary, "pgsql");
    mkdirSync(path.join(destination, "bin"), { recursive: true });
    mkdirSync(path.join(destination, "lib/postgresql"), { recursive: true });
    const selected = ["initdb", "pg_ctl", "postgres", "psql", "createdb"].map(
      (name) => `bin/${name}`
    );
    // Keep core procedural language, text search and encoding conversions. Optional
    // EDB Perl/Python/Tcl modules require a separately installed language pack.
    for (const name of readdirSync(path.join(source, "lib/postgresql"))) {
      if (
        /^(plpgsql|dict_snowball|utf8_and_.*|.*_and_mic|euc2004_sjis2004|euc_jp_and_sjis|latin2_and_win1250)\.dylib$/.test(
          name
        )
      )
        selected.push(`lib/postgresql/${name}`);
    }
    const copied = new Set();
    function copyWithDependencies(relative) {
      if (copied.has(relative)) return;
      copied.add(relative);
      const from = path.join(source, relative);
      const to = path.join(destination, relative);
      // Dereference library aliases so cp cannot rewrite them to absolute paths.
      cpSync(realpathSync(from), to);
      for (const dependency of dependencies(from)) {
        if (dependency.startsWith("@loader_path/")) {
          const resolved = path.resolve(
            path.dirname(from),
            dependency.slice("@loader_path/".length)
          );
          if (!resolved.startsWith(`${source}/`))
            throw new Error(`Dependency escapes archive: ${dependency}`);
          copyWithDependencies(path.relative(source, resolved));
        } else if (
          !dependency.startsWith("/usr/lib/") &&
          !dependency.startsWith("/System/Library/")
        )
          throw new Error(`External dependency: ${dependency}`);
      }
    }
    selected.forEach(copyWithDependencies);
    cpSync(path.join(source, "share"), path.join(destination, "share"), {
      recursive: true,
    });
    // Do not advertise extensions omitted from this deliberately small runtime.
    rmSync(path.join(destination, "share/postgresql/extension"), {
      recursive: true,
    });
    mkdirSync(path.join(destination, "share/postgresql/extension"));
    for (const name of readdirSync(
      path.join(source, "share/postgresql/extension")
    )) {
      if (name.startsWith("plpgsql"))
        cpSync(
          path.join(source, "share/postgresql/extension", name),
          path.join(destination, "share/postgresql/extension", name)
        );
    }
    mkdirSync(path.join(destination, "licenses"));
    cpSync(
      path.join(source, "doc/postgresql/html/legalnotice.html"),
      path.join(destination, "licenses/PostgreSQL.html")
    );
    cpSync(
      path.join(here, "macos-postgres-licenses"),
      path.join(destination, "licenses"),
      { recursive: true }
    );
    // libiconv is dynamically linked LGPL code. Include its matching upstream
    // source and build instructions, in addition to the license and notices.
    cpSync(
      fetchArchive({
        url: "https://ftp.gnu.org/pub/gnu/libiconv/libiconv-1.19.tar.gz",
        sha256:
          "88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6",
      }),
      path.join(destination, "licenses/libiconv-1.19.tar.gz")
    );
    writeFileSync(
      path.join(destination, "SOURCE.json"),
      `${JSON.stringify(postgresSource, null, 2)}\n`
    );
    verifyPostgres(destination, arch);
    console.log(`PostgreSQL ${postgresSource.version}: ${destination}`);
    return destination;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [
    arch = process.arch,
    destination = path.join(here, `../dist/postgres/${arch}`),
  ] = process.argv.slice(2);
  await downloadPostgres(arch, destination);
}
