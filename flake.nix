{
  description = "Deck: a Zig coordinator with a private TypeScript/Pi runtime";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Native cross-builds alone don't establish support for a full Nix closure.
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      builds = nixpkgs.lib.genAttrs systems (
        system:
        import ./nix/deck.nix {
          pkgs = import nixpkgs { inherit system; };
          inherit systems;
        }
      );
      select = name: nixpkgs.lib.mapAttrs (_: build: build.${name}) builds;
    in
    {
      packages = select "packages";
      checks = select "checks";
      devShells = select "devShells";
    };
}
