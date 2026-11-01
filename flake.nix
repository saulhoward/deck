{
  description = "Deck: a Zig coordinator with TypeScript/Pi agent runtimes";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "deck";
            version = "0.1.0-dev";
            src = self;
            nativeBuildInputs = [ pkgs.zig_0_15 ];
            dontConfigure = true;
            buildPhase = ''
              export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
              zig build -Doptimize=ReleaseSafe --prefix "$out"
            '';
            doCheck = true;
            checkPhase = "zig build test";
            dontInstall = true;
            meta = {
              description = "Deck agent harness (bootstrap CLI)";
              mainProgram = "deck";
              platforms = systems;
            };
          };
        });
      checks = eachSystem (system: { cli = self.packages.${system}.default; });
      devShells = eachSystem (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.mkShell {
            packages = [ pkgs.zig_0_15 pkgs.nodejs_24 pkgs.git pkgs.nixfmt ];
          };
        });
    };
}
