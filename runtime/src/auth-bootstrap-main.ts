import { bootstrap } from "./auth-bootstrap.js";
bootstrap(process.argv.slice(2)).catch(() => {
  // Never echo parser/exec errors containing file contents or environment data.
  process.stderr.write("deck: credential bootstrap failed; check private ~/.config/deck/.env references, op installation and sign-in. No fallback attempted.\n");
  process.exitCode = 1;
});
