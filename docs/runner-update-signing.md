# Runner update signing

Native releases publish one signed manifest beside each Linux runner archive.
The signed SHA-256 identifies the executable inside the archive. The controller
checks the phase 2 archive attestation, revision and platform, verifies the
manifest signature, and compares the extracted executable to the signed digest
before serving either update file.

## Provision the production signing key

Generate an Ed25519 key pair on a trusted machine, in a private directory
outside the checkout. For example, in a shell with OpenSSL and GitHub CLI
authenticated for release administration:

```sh
umask 077
mkdir -p "$HOME/.local/state/dispatch/runner-update-production"
cd "$HOME/.local/state/dispatch/runner-update-production"
test ! -e runner-a.private.pem || exit 1
openssl genpkey -algorithm Ed25519 -out runner-a.private.pem
openssl pkey -in runner-a.private.pem -pubout -out runner-a.public.pem
```

1. Add `["runner-a", \`<complete SPKI PEM from runner-a.public.pem>\`]`to the
active slot of`productionRunnerUpdateKeys` in
   [update-format.ts](../packages/runner-protocol/src/update-format.ts). Use the
   standby slot in the same map for rotation.
   Commit the public PEM and its stable key ID, and merge them before cutting
   the first native release with signed updates.
2. Store the private PKCS#8 PEM in the repository's GitHub Actions secret
   `RUNNER_UPDATE_SIGNING_KEY` and set the Actions variable
   `RUNNER_UPDATE_SIGNING_KEY_ID` to `runner-a`.

   ```sh
   gh secret set RUNNER_UPDATE_SIGNING_KEY --repo selfcontained/dispatch < runner-a.private.pem
   gh variable set RUNNER_UPDATE_SIGNING_KEY_ID --repo selfcontained/dispatch --body runner-a
   ```

3. Keep the production private key in the owner's protected backup. The publish
   job requires both settings for native runner artifacts and verifies that each
   generated signature matches a committed public key before publishing.

For rotation, use a distinct key ID such as `runner-b` and add its public PEM in
the standby slot. Continue signing with A until the runners in the supported
upgrade window trust B. Then update the Actions secret and variable together
before cutting the first release signed by B. The verifier accepts a valid
signature from either trusted key. Retire A after the supported skew window.

## Signature lifetime and key retirement

Runner update signatures do not expire and cannot be revoked. A compromised
controller can move a runner forward to any previously signed higher version.
The persisted version floor only stops downgrades. To retire a signing key,
remove its public key in a later runner release.

## Sign development artifacts

Compile the Linux binaries with the explicit development trust switch.

```sh
DISPATCH_RUNNER_UPDATE_DEV_BUILD=1 DISPATCH_BUN_TARGETS=bun-linux-x64,bun-linux-arm64 pnpm run build:bun
```

The build creates a dedicated Ed25519 key pair on demand under
`~/.local/state/dispatch/runner-update-dev/` with a mode-0600 private key. The
build embeds the public key. Production binaries have no development key.
An unpackaged controller serves these updates when explicitly configured with
`DISPATCH_RUNNER_ARTIFACT_DEV_DIR` and reads the development public PEM from the
same user's state directory. A production-compiled controller disables update
serving when pointed at a development artifact directory.

Pack the native archives with `bin/pack-release --runner-arch`, then sign the
archive for each architecture into the same directory as the archive and the
bootstrap. Set `artifact_dir` to that directory. Run from the checkout root.

```sh
version=$(node -p "require('./package.json').version")
for arch in x64 arm64; do
  bun scripts/sign-runner-update.mjs --dev "$version" "$arch" \
    "$artifact_dir/dispatch-runner-linux-$arch.tar.gz" \
    "$artifact_dir/dispatch-runner-linux-$arch.manifest.json"
done
```

Both the web origin and runner listener use
`/api/v1/runner-artifacts/<revision>/update/<version>/linux/<arch>/<sha256>/`
with `manifest.json`, `dispatch-runner` and `dispatch-runner.gz` as filenames.
The same files are served without the `<revision>/` segment for the root
updater, which knows only the signed version, platform and digest.
`dispatch-runner.gz` is the executable as a gzip body, about a third of its
size; the updater checks the signed digest of the decompressed bytes. The signed bytes are
the UTF-8 JSON representation of the manifest object, with `version`, `os`,
`arch`, and `sha256` in that order, without whitespace or a trailing newline.
The signature is standard padded Base64 over the 64-byte Ed25519 signature.
