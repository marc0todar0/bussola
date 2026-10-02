// The demo's side of fetch: what fetchAuth and session.js call instead of the
// network in the demo build (see server.js). The dataset is created the first
// time it is asked for and lives until the tab is reloaded.
import fixture from "./fixture.json";
import { createServer } from "./server.js";

let server = null;

export const handle = async (path, options = {}) => {
  if (!server) server = createServer(fixture);
  let body;
  try {
    body = typeof options.body === "string" && options.body ? JSON.parse(options.body) : undefined;
  } catch {
    body = undefined;
  }
  const out = server.handle(options.method || "GET", path, body);
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json" },
  });
};
