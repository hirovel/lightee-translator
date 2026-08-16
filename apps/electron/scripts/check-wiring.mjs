import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const mapPath = resolve(appRoot, "wiring/electron-wiring.json");
const docPath = resolve(appRoot, "wiring/electron-wiring.html");
const map = JSON.parse(await readFile(mapPath, "utf8"));
const doc = await readFile(docPath, "utf8");

const fail = (message) => { throw new Error(`Wiring map check failed: ${message}`); };
const embeddedMatch = doc.match(/<script type="application\/json" id="wiring-data">([\s\S]*?)<\/script>/);
if (!embeddedMatch) fail("generated document has no embedded wiring data");
let embedded;
try {
  embedded = JSON.parse(embeddedMatch[1]);
} catch (error) {
  fail(`embedded wiring data is not valid JSON: ${error.message}`);
}
if (embedded.nodes?.length !== map.nodes.length || embedded.edges?.length !== map.edges.length) {
  fail("embedded wiring data does not match the source map counts");
}
if (embeddedMatch[1].includes("&quot;")) fail("embedded JSON is HTML-escaped inside a raw-text script element");
const unique = (items, name) => {
  const ids = items.map((item) => item.id ?? item.name);
  if (new Set(ids).size !== ids.length) fail(`${name} contains duplicate ids`);
};
unique(map.layers, "layers");
unique(map.nodes, "nodes");
unique(map.edges, "edges");
unique(map.channels, "channels");
unique(map.commands, "commands");
unique(map.tickets, "tickets");
const nodeIds = new Set(map.nodes.map((node) => node.id));
for (const edge of map.edges) {
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail(`edge ${edge.id} points to an unknown node`);
}
const layerIds = new Set(map.layers.map((layer) => layer.id));
for (const node of map.nodes) {
  if (!layerIds.has(node.layer)) fail(`node ${node.id} points to an unknown layer`);
}
for (const required of ["Frontend", "preload", "Electron main", "IpcService", "lightee:invoke", "chapter.saveDraft", "CodeMirror 6", "Channels", "Commands", "Tickets", "data-channel", "data-command", "data-ticket"]) {
  if (!doc.includes(required)) fail(`generated document is missing ${required}`);
}
await access(docPath);
console.log(`Wiring map OK: ${map.nodes.length} nodes, ${map.edges.length} edges, ${map.commands.length} command groups`);
