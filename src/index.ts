// Entry point the runner executes (bundled into dist/index.js with the Node client; no node_modules needed at run time).
import { run } from "./main.js";

run({ env: process.env, log: (line) => console.log(line) })
  .then((r) => { process.exitCode = r.exitCode; })
  .catch((err) => { console.log(`::error title=MailPier Inbox::${String(err)}`); process.exitCode = 1; });
