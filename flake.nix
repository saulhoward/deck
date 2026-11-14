{
  description = "Deck: a Zig coordinator with a private TypeScript/Pi runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # The pinned Nixpkgs has dropped x86_64-darwin. Native Zig cross-builds
      # for Intel macOS do not establish support for its full Nix closure.
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      terminalSources = pkgs: {
        vaxis = pkgs.fetchzip {
          extension = "tar.gz";
          url = "https://codeload.github.com/rockorager/libvaxis/tar.gz/74b7d916c8879e5379f428ea8c4d43d1a1bb061b";
          hash = "sha256-T8i4NUXLuvo399l1s7IbFZ8Dk2ll0D/aM+Je+/b4DMc=";
        };
        unicode = pkgs.fetchzip {
          extension = "tar.gz";
          url = "https://codeload.github.com/jacobsandlund/uucode/tar.gz/1fb73433bba5d93366c57f23ff2e9d7939746500";
          hash = "sha256-fZTYVFN0N10R0Ty+3tpMkTLqEBq4tTpkBK6G1m6VgmY=";
        };
      };
    in
    {
      packages = eachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          sources = terminalSources pkgs;
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "deck";
            version = "0.1.0-dev";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./build.zig
                ./build.zig.zon
                ./src
                ./licenses
                ./contracts
                ./scripts
                ./runtime/src
                ./runtime/tsconfig.json
                ./package.json
                ./package-lock.json
              ];
            };
            nodejs = pkgs.nodejs_24;
            npmDepsHash = "sha256-CE3g6O9SEi/7POrAepMoor5tqZ3IGZZlLmXR4AqAi+k=";
            npmFlags = [ "--ignore-scripts" ];
            nativeBuildInputs = [
              pkgs.zig_0_17
              (pkgs.python3.withPackages (ps: [ ps.pyte ])) # PTY/screen tests only.
              pkgs.makeWrapper
            ];
            buildPhase = ''
              runHook preBuild
              export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
              # 0.17 caches packages as archives. Seed from fixed, unpacked Nix
              # sources: no network in the build, no nested-root fetch-cache bug.
              zig fetch ${sources.vaxis}
              zig fetch ${sources.unicode}
              npm run contracts:check
              zig build -Doptimize=ReleaseSafe --prefix "$TMPDIR/deck-zig"
              npm run build
              runHook postBuild
            '';
            __darwinAllowLocalNetworking = true; # Offline tests bind loopback only.
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              zig build test
              npm run check
              DECK_TEST_BINARY="$TMPDIR/deck-zig/bin/deck" npm test
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall
              npm prune --omit=dev --no-save --ignore-scripts --offline
              mkdir -p "$out/bin" "$out/libexec/deck/runtime"
              cp "$TMPDIR/deck-zig/bin/deck" "$out/bin/deck"
              cp "$TMPDIR/deck-zig/bin/deck-worker" "$out/bin/deck-worker"
              wrapProgram "$out/bin/deck-worker" \
                --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.bash ]}"
              cp -r "$TMPDIR/deck-zig/share" "$out/share"
              cp package.json "$out/libexec/deck/"
              cp -r runtime/dist "$out/libexec/deck/runtime/"
              find "$out/libexec/deck/runtime/dist" -name '*.test.*' -delete
              cp -r node_modules "$out/libexec/deck/"
              wrapProgram "$out/bin/deck" \
                --set DECK_RUNTIME_ROOT "$out/libexec/deck" \
                --set DECK_NODE "${pkgs.nodejs_24}/bin/node" \
                --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.bash ]}"
              runHook postInstall
            '';
            doInstallCheck = true;
            installCheckPhase = ''
              runHook preInstallCheck
              DECK_PACKAGE_BINARY="$out/bin/deck" node --test runtime/dist/package.test.js
              runHook postInstallCheck
            '';
            meta = {
              description = "Deck local agent prototype: Zig hub and tools, central Pi conversations";
              mainProgram = "deck";
              platforms = systems;
            };
          };
          # Copy only the standalone native executable. No reference to the hub
          # package, Node, Pi, provider libraries or the renderer at runtime.
          worker = pkgs.runCommand "deck-worker-0.1.0-dev" {
            nativeBuildInputs = [ pkgs.makeWrapper pkgs.removeReferencesTo ];
            disallowedRequisites = [ self.packages.${system}.default pkgs.nodejs_24 pkgs.zig_0_17 ];
            meta = { description = "Deck native files/bash/MCP worker (no Pi runtime)"; mainProgram = "deck-worker"; platforms = systems; };
          } ''
            mkdir -p "$out/bin"
            cp ${self.packages.${system}.default}/bin/.deck-worker-wrapped "$out/bin/deck-worker"
            # Source-location/debug strings must not retain the build compiler.
            chmod u+w "$out/bin/deck-worker"
            remove-references-to -t ${pkgs.zig_0_17} "$out/bin/deck-worker"
            wrapProgram "$out/bin/deck-worker" --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.bash ]}"
            "$out/bin/deck-worker" --help > /dev/null
          '';
        }
      );
      checks = eachSystem (system: {
        package = self.packages.${system}.default;
        worker = self.packages.${system}.worker;
      });
      devShells = eachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            shellHook = ''
              zig fetch ${(terminalSources pkgs).vaxis} >/dev/null
              zig fetch ${(terminalSources pkgs).unicode} >/dev/null
            '';
            packages = [
              pkgs.zig_0_17
              pkgs.nodejs_24
              (pkgs.python3.withPackages (ps: [ ps.pyte ]))
              pkgs.git
              pkgs.nixfmt
            ];
          };
        }
      );
    };
}
