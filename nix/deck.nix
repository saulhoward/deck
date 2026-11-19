{ pkgs, systems }:
let
  inherit (pkgs) lib;
  version = "0.1.0-dev";
  node = pkgs.nodejs_24;
  zig = pkgs.zig_0_17;
  python = pkgs.python3.withPackages (ps: [ ps.pyte ]);
  source =
    paths:
    lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions paths;
    };
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
  seedZig = ''
    zig fetch ${vaxis} >/dev/null
    zig fetch ${unicode} >/dev/null
  '';
  nativeSrc = source [
    ../build.zig
    ../build.zig.zon
    ../src
    ../licenses
  ];
  native = pkgs.stdenv.mkDerivation {
    pname = "deck-native";
    inherit version;
    src = nativeSrc;
    nativeBuildInputs = [ zig ];
    buildPhase = ''
      export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
      ${seedZig}
      zig build -j1 -Dserial=true -Doptimize=ReleaseSafe --prefix "$out" --summary all
    '';
    dontInstall = true;
  };
  manifests = [
    ../package.json
    ../package-lock.json
  ];
  runtime = pkgs.buildNpmPackage {
    pname = "deck-runtime";
    inherit version;
    src = source (
      manifests
      ++ [
        ../runtime/src
        ../runtime/tsconfig.json
      ]
    );
    nodejs = node;
    npmDeps = pkgs.fetchNpmDeps {
      name = "deck-${version}-npm-deps";
      src = source manifests;
      hash = "sha256-CE3g6O9SEi/7POrAepMoor5tqZ3IGZZlLmXR4AqAi+k=";
    };
    npmFlags = [ "--ignore-scripts" ];
    outputs = [
      "out"
      "testkit"
    ];
    # One strict compile, including fixtures. Keep tests/dev tools out of the
    # installed closure, but make the emitted suite available without recompiling.
    buildPhase = "time npm run build";
    installPhase = ''
      mkdir -p "$out/runtime" "$testkit/runtime"
      cp -r runtime/dist "$testkit/runtime/"
      cp package.json "$testkit/"
      cp -r node_modules/typescript "$testkit/"
      npm prune --omit=dev --no-save --ignore-scripts --offline
      find runtime/dist -name '*.test.*' -delete
      mv runtime/dist "$out/runtime/"
      mv package.json node_modules "$out/"
    '';
  };
  bashPath = lib.makeBinPath [ pkgs.bash ];
  package =
    pkgs.runCommand "deck-${version}"
      {
        nativeBuildInputs = [
          pkgs.makeWrapper
          node
        ];
        __darwinAllowLocalNetworking = true;
        passthru = {
          inherit runtime;
          tests = runtime.testkit;
        };
        meta = {
          description = "Deck local agent prototype: Zig hub and tools, central Pi conversations";
          mainProgram = "deck";
          platforms = systems;
        };
      }
      ''
        mkdir -p "$out/bin" "$out/libexec"
        cp ${native}/bin/{deck,deck-worker} "$out/bin/"
        cp -r ${native}/share "$out/"
        ln -s ${runtime} "$out/libexec/deck"
        wrapProgram "$out/bin/deck-worker" --prefix PATH : "${bashPath}"
        wrapProgram "$out/bin/deck" --set DECK_RUNTIME_ROOT "$out/libexec/deck" --set DECK_NODE "${node}/bin/node" --prefix PATH : "${bashPath}"
        DECK_PACKAGE_BINARY="$out/bin/deck" node --test ${runtime.testkit}/runtime/dist/package.test.js
      '';
  worker =
    pkgs.runCommand "deck-worker-${version}"
      {
        nativeBuildInputs = [
          pkgs.makeWrapper
          pkgs.removeReferencesTo
        ];
        disallowedRequisites = [
          native
          node
          zig
        ];
        meta = {
          description = "Deck native files/bash/MCP worker (no Pi runtime)";
          mainProgram = "deck-worker";
          platforms = systems;
        };
      }
      ''
        mkdir -p "$out/bin"
        cp ${native}/bin/deck-worker "$out/bin/"
        chmod u+w "$out/bin/deck-worker"
        remove-references-to -t ${zig} "$out/bin/deck-worker"
        wrapProgram "$out/bin/deck-worker" --prefix PATH : "${bashPath}"
        "$out/bin/deck-worker" --help > /dev/null
      '';
  terminalScripts = lib.fileset.unions [
    ../scripts/tui-pty-test.py
    ../scripts/tui_pty_screen.py
    ../scripts/tui_pty_screen_test.py
    ../scripts/tui-pty-screen.test.mjs
  ];
  integrationSrc =
    suite:
    source [
      (if suite == "terminal" then terminalScripts else lib.fileset.difference ../scripts terminalScripts)
      ../scripts/test-runtime.mjs
      ../contracts
      (lib.fileset.fileFilter (f: lib.hasSuffix ".test.json" f.name) ../src)
    ];
  checkRuntime =
    suite:
    pkgs.runCommand "deck-${suite}-tests"
      {
        nativeBuildInputs = [
          node
          python
          zig
        ];
        __darwinAllowLocalNetworking = true;
      }
      ''
        export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
        cp -r ${integrationSrc suite}/. .
        cp -r ${runtime.testkit}/{package.json,runtime} .
        chmod -R u+w runtime
        mkdir node_modules
        ln -s ${runtime}/node_modules/* node_modules/
        ln -s ${runtime.testkit}/typescript node_modules/typescript
        # Exercise the raw checkout layout, not a /nix/store/...-deck-... wrapper.
        mkdir bin
        cp ${native}/bin/{deck,deck-worker} bin/
        DECK_TEST_BINARY="$PWD/bin/deck" node scripts/test-runtime.mjs ${suite}
        touch "$out"
      '';
in
{
  packages = {
    default = package;
    inherit worker;
  };
  checks = {
    inherit package worker;
    native =
      pkgs.runCommand "deck-native-tests"
        {
          nativeBuildInputs = [
            zig
            node
          ]; # The inherited-pipes test uses a real Node child.
          __darwinAllowLocalNetworking = true;
        }
        ''
          cp -r ${nativeSrc}/. .
          export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
          ${seedZig}
          zig build test -j1 --summary all
          touch "$out"
        '';
    contracts =
      pkgs.runCommand "deck-generated-contracts"
        {
          nativeBuildInputs = [
            node
            zig
          ];
        }
        ''
          cd ${
            source [
              ../contracts
              ../scripts/generate-contracts.mjs
              ../src/generated
              ../runtime/src/generated
            ]
          }
          node scripts/generate-contracts.mjs --check
          touch "$out"
        '';
    integration = checkRuntime "integration";
    terminal = checkRuntime "terminal";
  };
  devShells.default = pkgs.mkShell {
    shellHook = seedZig;
    packages = [
      zig
      node
      python
      pkgs.git
      pkgs.nixfmt
    ];
  };
}
