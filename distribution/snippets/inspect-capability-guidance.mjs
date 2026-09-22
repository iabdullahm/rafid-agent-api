// Fetch GET /api/v1/capabilities and print one capability's tool-selection guidance
// (priorityContexts / evidenceTypes / limitations / sampleQueries) — the fields an agent
// should read before deciding to call analyze_oman_property. See ../AGENT-DISCOVERY.md.

const BASE_URL = "https://rafid-agent-api.vercel.app";

const res = await fetch(`${BASE_URL}/api/v1/capabilities`);
const { data: tools } = await res.json(); // envelope: { success, data, meta } — data is the array

const omanTool = tools.find((t) => t.name === "analyze_oman_property");

console.log("whenToUse:", omanTool.whenToUse);
console.log("priorityContexts:", omanTool.priorityContexts);
console.log("evidenceTypes:", omanTool.evidenceTypes);
console.log("limitations:", omanTool.limitations);
console.log("sampleQueries:", omanTool.sampleQueries);

// Every other capability has these same fields, as empty arrays, never omitted:
const compareTool = tools.find((t) => t.name === "compare_properties");
console.log("compare_properties priorityContexts (empty today):", compareTool.priorityContexts);
