{
  description = "Deck: a Zig coordinator with a private TypeScript/Pi runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = eachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "deck";
            version = "0.1.0-dev";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./build.zig
                ./src
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
              pkgs.zig_0_15
              pkgs.makeWrapper
            ];
            buildPhase = ''
              runHook preBuild
              export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
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
        }
      );
      checks = eachSystem (system: {
        package = self.packages.${system}.default;
      });
      devShells = eachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.zig_0_15
              pkgs.nodejs_24
              pkgs.git
              pkgs.nixfmt
            ];
          };
        }
      );
    };
}
