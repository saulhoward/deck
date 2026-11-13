import { runLogin } from "./login-runner.js";
runLogin(process.argv.slice(2)).catch(() => {
  process.stderr.write("deck: OpenAI login failed or cancelled; check --directory, running hub --port, and sign-in interaction. No credential fallback attempted.\n");
  process.exitCode = 1;
});
