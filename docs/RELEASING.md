# Releasing

1. Make sure `main` is green (CI: typecheck, tests with Postgres, image build and vulnerability scan, Helm lint).
2. Pick the version (semver): breaking changes to configuration or behaviour → major, features → minor, fixes → patch.
3. Update the version in three places:
   - `package.json` → `version`
   - `deploy/helm/heinzel/Chart.yaml` → `version` and `appVersion`
   - `CHANGELOG.md` → rename `[Unreleased]` to `[x.y.z] - YYYY-MM-DD`, add a new empty `[Unreleased]`, add upgrade notes if anyone needs to act
4. Commit (`Release x.y.z`), then tag and push:
   ```bash
   git tag -a vx.y.z -m "Heinzel x.y.z"
   git push origin main vx.y.z
   ```
5. The release workflow checks that tag, package.json, chart and changelog agree, then publishes:
   - `ghcr.io/v0lumehi/heinzel` and `ghcr.io/v0lumehi/heinzel-coder` for amd64 and arm64, tagged `x.y.z` and `x.y`, with SBOM and provenance, signed with cosign
   - the Helm chart at `oci://ghcr.io/v0lumehi/charts/heinzel`
   - a GitHub release with the changelog section as notes

The first time, make the GHCR packages public (GitHub → *Packages* → package → *Package settings* → *Change visibility*) if they should be pullable without login.
