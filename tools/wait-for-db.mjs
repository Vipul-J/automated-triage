import { execSync } from "node:child_process";
process.stdout.write("waiting for postgres");
for (let i = 0; i < 60; i++) {
  try {
    execSync("docker exec triage-db pg_isready -U triage -d triage", { stdio: "ignore" });
    console.log(" ready");
    process.exit(0);
  } catch {
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.error("\npostgres did not become ready in 60s");
process.exit(1);
